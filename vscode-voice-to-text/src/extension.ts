import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, ChildProcess, execSync } from 'child_process';
import axios from 'axios';
import FormData from 'form-data';

const isWindows = process.platform === 'win32';
let recordingProcess: ChildProcess | null = null;
let recordingFile: string | null = null;
let statusBarItem: vscode.StatusBarItem;
let recordingTimer: ReturnType<typeof setInterval> | null = null;
let recordingStartTime: number = 0;
let isTranscribing = false;
let serviceHealthy: boolean | null = null;
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

function findSox(): string | null {
    try {
        const cmd = isWindows ? 'where sox' : 'which sox';
        const result = execSync(cmd, { encoding: 'utf8', windowsHide: true }).trim().split('\n')[0].trim();
        return result || null;
    } catch {
        return null;
    }
}

function findFfmpeg(): string | null {
    try {
        const cmd = isWindows ? 'where ffmpeg' : 'which ffmpeg';
        const result = execSync(cmd, { encoding: 'utf8', windowsHide: true }).trim().split('\n')[0].trim();
        return result || null;
    } catch {
        return null;
    }
}

async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    opts: { retries?: number; baseDelayMs?: number; shouldRetry?: (err: any) => boolean } = {}
): Promise<T> {
    const { retries = 3, baseDelayMs = 1000, shouldRetry } = opts;
    let lastError: any;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            lastError = err;
            if (attempt === retries) { break; }
            if (shouldRetry && !shouldRetry(err)) { break; }
            const delay = baseDelayMs * Math.pow(2, attempt);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastError;
}

function isValidWav(filePath: string): boolean {
    try {
        const fd = fs.openSync(filePath, 'r');
        const header = Buffer.alloc(12);
        fs.readSync(fd, header, 0, 12, 0);
        fs.closeSync(fd);
        return header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE';
    } catch {
        return false;
    }
}

function cleanupStaleTempFiles() {
    try {
        const tmpDir = os.tmpdir();
        const files = fs.readdirSync(tmpDir);
        const oneHourAgo = Date.now() - 3600000;
        for (const f of files) {
            if (f.startsWith('voice-') && f.endsWith('.wav')) {
                const fullPath = path.join(tmpDir, f);
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.mtimeMs < oneHourAgo) {
                        fs.unlinkSync(fullPath);
                    }
                } catch { /* ignore */ }
            }
        }
    } catch { /* ignore */ }
}

function startHealthMonitor() {
    healthCheckInterval = setInterval(async () => {
        if (recordingProcess || isTranscribing) { return; }
        const healthy = await checkServiceHealth();
        if (serviceHealthy === true && !healthy) {
            statusBarItem.text = '$(warning) Speak Claude';
            statusBarItem.tooltip = 'WhisperX service is unavailable';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else if (healthy && serviceHealthy !== true) {
            if (!recordingProcess && !isTranscribing) {
                statusBarItem.text = '$(unmute) Speak Claude';
                statusBarItem.tooltip = 'Click to start voice recording (Ctrl+Shift+C)';
                statusBarItem.backgroundColor = undefined;
            }
        }
        serviceHealthy = healthy;
    }, 30000);
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Voice to Text extension activated');

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'voice-to-text.record';
    statusBarItem.text = '$(unmute) Speak Claude';
    statusBarItem.tooltip = 'Click to start voice recording (Ctrl+Shift+C)';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Register command
    let disposable = vscode.commands.registerCommand('voice-to-text.record', async () => {
        if (recordingProcess) {
            // Already recording, stop it
            await stopRecording();
        } else {
            // Start recording
            await startRecording();
        }
    });

    context.subscriptions.push(disposable);

    // Cleanup stale temp files from previous sessions and start background health monitoring
    cleanupStaleTempFiles();
    startHealthMonitor();
}

async function checkServiceHealth(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('voiceToText');
    const whisperxUrl = config.get<string>('whisperxUrl', 'http://localhost:48001');
    try {
        const resp = await axios.get(`${whisperxUrl}/health`, { timeout: 3000 });
        return resp.data.status === 'healthy';
    } catch {
        return false;
    }
}

async function startRecording() {
    try {
        // Check service health before recording so the user doesn't waste time
        const healthy = await checkServiceHealth();
        if (!healthy) {
            vscode.window.showErrorMessage(
                'WhisperX service is not running or not ready. Start it with: cd whisperx-service && uvicorn main:app --port 48001'
            );
            return;
        }

        // Check if sox is installed
        const soxPath = findSox();
        if (!soxPath) {
            throw new Error('sox not found');
        }

        // Create temporary file for recording
        recordingFile = path.join(os.tmpdir(), `voice-${Date.now()}.wav`);

        // Start recording with sox
        // Windows SoX doesn't support '-d' (no default device) — use waveaudio driver instead
        const soxArgs = isWindows
            ? ['-t', 'waveaudio', 'default', '-r', '16000', '-c', '1', '-b', '16', recordingFile]
            : ['-d', '-r', '16000', '-c', '1', '-b', '16', recordingFile];
        recordingProcess = spawn(soxPath, soxArgs, { windowsHide: true });

        // Update status bar with live elapsed timer
        statusBarItem.tooltip = 'Click to stop recording (Ctrl+Shift+C)';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        recordingStartTime = Date.now();
        statusBarItem.text = '$(mic) 0:00';
        recordingTimer = setInterval(() => {
            const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
            const mins = Math.floor(elapsed / 60);
            const secs = elapsed % 60;
            statusBarItem.text = `$(mic) ${mins}:${secs.toString().padStart(2, '0')}`;

            // Auto-stop at max duration
            const config = vscode.workspace.getConfiguration('voiceToText');
            const maxSeconds = config.get<number>('maxRecordingSeconds', 120);
            if (maxSeconds > 0 && elapsed >= maxSeconds) {
                vscode.window.showWarningMessage(`Recording stopped: ${maxSeconds}s limit reached`);
                stopRecording();
            }
        }, 1000);

        vscode.window.showInformationMessage('Recording... Click the status bar button again to stop');

        recordingProcess.on('error', (err) => {
            vscode.window.showErrorMessage(`Recording failed: ${err.message}`);
            resetRecordingState();
        });

        recordingProcess.on('exit', (code, _signal) => {
            // If SoX exits unexpectedly while we still think we're recording
            if (recordingProcess !== null && code !== null && code !== 0) {
                vscode.window.showErrorMessage(
                    `Recording stopped unexpectedly (exit code ${code}). Check your audio device.`
                );
                resetRecordingState();
            }
        });

    } catch (error: any) {
        if (error.message === 'sox not found') {
            const installOption = isWindows ? 'Install via WinGet' : 'Install via Homebrew';
            const answer = await vscode.window.showErrorMessage(
                'SoX is required for audio recording. Install it to use voice input.',
                installOption,
                'Cancel'
            );
            if (answer === installOption) {
                const url = isWindows
                    ? 'https://sourceforge.net/projects/sox/files/sox/'
                    : 'https://formulae.brew.sh/formula/sox';
                vscode.env.openExternal(vscode.Uri.parse(url));
            }
        } else {
            vscode.window.showErrorMessage(`Failed to start recording: ${error.message}`);
        }
        resetRecordingState();
    }
}

async function stopRecording() {
    if (!recordingProcess || !recordingFile) {
        return;
    }

    // Prevent concurrent transcriptions
    if (isTranscribing) {
        vscode.window.showWarningMessage('A transcription is already in progress. Please wait.');
        return;
    }
    isTranscribing = true;

    // Stop recording — on Windows SIGINT doesn't flush the WAV file, so just kill
    if (isWindows) {
        recordingProcess.kill();
    } else {
        recordingProcess.kill('SIGINT');
    }
    recordingProcess = null;

    // Update status bar to show processing with elapsed timer
    const transcribeStart = Date.now();
    statusBarItem.text = '$(loading~spin) Transcribing...';
    statusBarItem.tooltip = 'Processing audio...';
    const transcribeTimer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - transcribeStart) / 1000);
        statusBarItem.text = `$(loading~spin) Transcribing (${elapsed}s)...`;
    }, 1000);

    try {
        // Wait for file to be written — longer on Windows since kill() is abrupt
        await new Promise(resolve => setTimeout(resolve, isWindows ? 1500 : 500));

        // Check if file exists and has content
        if (!fs.existsSync(recordingFile) || fs.statSync(recordingFile).size === 0) {
            throw new Error('No audio was recorded');
        }

        // On Windows, sox is killed abruptly so the WAV header size field is never updated.
        // Re-encode with ffmpeg so the header is correct and whisperx gets the full audio.
        if (isWindows) {
            const ffmpegPath = findFfmpeg();
            if (ffmpegPath) {
                const fixedFile = recordingFile.replace('.wav', '_fixed.wav');
                try {
                    execSync(`"${ffmpegPath}" -y -hide_banner -loglevel error -i "${recordingFile}" -c:a pcm_s16le "${fixedFile}"`, { windowsHide: true });
                    fs.unlinkSync(recordingFile);
                    recordingFile = fixedFile;
                } catch {
                    // If ffmpeg fails, proceed with original file
                }
            } else {
                // No ffmpeg on Windows — WAV header is likely corrupt from abrupt kill
                if (!isValidWav(recordingFile)) {
                    throw new Error(
                        'Audio file is corrupt (WAV header invalid). Install ffmpeg to fix this automatically on Windows.'
                    );
                }
            }
        }

        // Validate WAV before sending to avoid a wasted 5-minute timeout
        if (!isValidWav(recordingFile)) {
            throw new Error('Audio file is corrupt (invalid WAV header). Try recording again.');
        }

        // Send to WhisperX service
        const config = vscode.workspace.getConfiguration('voiceToText');
        const whisperxUrl = config.get<string>('whisperxUrl', 'http://localhost:48001');
        const language = config.get<string>('language', '');
        const diarization = config.get<boolean>('diarization', false);

        // Read file into buffer once so retries don't fail on consumed streams
        const fileBuffer = fs.readFileSync(recordingFile);

        const response = await retryWithBackoff(
            () => {
                const formData = new FormData();
                formData.append('file', fileBuffer, {
                    filename: 'recording.wav',
                    contentType: 'audio/wav'
                });
                formData.append('diarize', String(diarization));
                formData.append('align', 'true');
                if (language) {
                    formData.append('language', language);
                }
                return axios.post(`${whisperxUrl}/transcribe`, formData, {
                    headers: formData.getHeaders(),
                    timeout: 300000,
                });
            },
            {
                retries: 3,
                baseDelayMs: 1000,
                shouldRetry: (err: any) => {
                    if (!err.response) { return true; } // network error — retry
                    return err.response.status >= 500;   // server error — retry
                },
            }
        );

        const transcript = response.data.transcript;

        if (!transcript || transcript.trim().length === 0) {
            throw new Error('No speech detected in recording');
        }

        // Insert text into active editor or input
        await insertText(transcript.trim());

        vscode.window.showInformationMessage(`Transcribed: "${transcript.substring(0, 50)}${transcript.length > 50 ? '...' : ''}"`);

    } catch (error: any) {
        if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') {
            serviceHealthy = false;
            vscode.window.showErrorMessage(
                'WhisperX service connection lost. It may have restarted. Please try again in a moment.'
            );
        } else {
            vscode.window.showErrorMessage(`Transcription failed: ${error.message}`);
        }
    } finally {
        isTranscribing = false;
        clearInterval(transcribeTimer);
        // Cleanup
        if (recordingFile && fs.existsSync(recordingFile)) {
            try { fs.unlinkSync(recordingFile); } catch { /* ignore */ }
        }
        resetRecordingState();
    }
}

async function insertText(text: string) {
    // Try to insert into active text editor first
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        await editor.edit(editBuilder => {
            editBuilder.insert(editor.selection.active, text);
        });
        return;
    }

    // No active editor (e.g. Claude Code chat panel) — clipboard + keyboard simulation.
    //
    // Root causes of the previous approach failing:
    //   1. execSync without windowsHide:true spawns a visible console window on Windows,
    //      which briefly steals keyboard focus away from the VS Code chat panel.
    //   2. The Python one-liner had no SetForegroundWindow call, so if focus had drifted
    //      (e.g. status-bar click), Ctrl+V fired into the wrong element.
    //   3. 50 ms sleep was too short once Python process startup time is factored in.
    //
    // Fix: write a temp .py file (avoids quote-escaping issues), suppress the console
    // window with windowsHide:true, find the VS Code window by title and call
    // SetForegroundWindow before sending Ctrl+V, then wait 250 ms for focus to settle.
    await vscode.env.clipboard.writeText(text);

    if (isWindows) {
        const python = findPython();
        if (python) {
            const tmpScript = path.join(os.tmpdir(), `speak_paste_${Date.now()}.py`);
            try {
                fs.writeFileSync(tmpScript, [
                    'import ctypes, time',
                    'u = ctypes.windll.user32',
                    '',
                    '# Locate the VS Code main window and bring it to the foreground so',
                    '# that keybd_event delivers Ctrl+V to the correct application.',
                    'WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_size_t, ctypes.c_size_t)',
                    'hwnds = []',
                    'def _cb(hwnd, lp):',
                    '    if u.IsWindowVisible(hwnd):',
                    '        n = u.GetWindowTextLengthW(hwnd)',
                    '        if n > 0:',
                    '            buf = (ctypes.c_wchar * (n + 1))()',
                    '            u.GetWindowTextW(hwnd, buf, n + 1)',
                    '            if "Visual Studio Code" in buf.value:',
                    '                hwnds.append(hwnd)',
                    '    return True',
                    'u.EnumWindows(WNDENUMPROC(_cb), 0)',
                    'if hwnds:',
                    '    u.SetForegroundWindow(hwnds[0])',
                    '',
                    '# Allow focus to settle before sending keystrokes.',
                    'time.sleep(0.25)',
                    '',
                    '# Send Ctrl+V (0x11 = VK_CONTROL, 0x56 = VK_V, 0x0002 = KEYEVENTF_KEYUP)',
                    'u.keybd_event(0x11, 0, 0, 0)',
                    'u.keybd_event(0x56, 0, 0, 0)',
                    'u.keybd_event(0x56, 0, 2, 0)',
                    'u.keybd_event(0x11, 0, 2, 0)',
                ].join('\n'));

                // windowsHide:true uses CREATE_NO_WINDOW — the Python process runs
                // silently without a console window, so focus is never stolen.
                execSync(`"${python}" "${tmpScript}"`, { windowsHide: true });
            } catch {
                vscode.window.showInformationMessage('Text copied to clipboard — press Ctrl+V to paste');
            } finally {
                try { fs.unlinkSync(tmpScript); } catch { /* ignore cleanup errors */ }
            }
        } else {
            vscode.window.showInformationMessage('Text copied to clipboard — press Ctrl+V to paste');
        }
    } else {
        try {
            execSync(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`);
        } catch {
            vscode.window.showInformationMessage('Text copied to clipboard — press Cmd+V to paste');
        }
    }
}

function findPython(): string | null {
    for (const cmd of ['python', 'python3']) {
        try {
            const result = execSync(
                isWindows ? `where ${cmd}` : `which ${cmd}`,
                { encoding: 'utf8', windowsHide: true }
            ).trim().split('\n')[0].trim();
            if (result) { return result; }
        } catch { /* try next */ }
    }
    return null;
}

function resetRecordingState() {
    recordingProcess = null;
    recordingFile = null;
    isTranscribing = false;
    if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
    statusBarItem.text = '$(unmute) Speak Claude';
    statusBarItem.tooltip = 'Click to start voice recording (Ctrl+Shift+C)';
    statusBarItem.backgroundColor = undefined;
}

export function deactivate() {
    if (healthCheckInterval) { clearInterval(healthCheckInterval); }
    if (recordingTimer) { clearInterval(recordingTimer); }
    if (recordingProcess) {
        try { recordingProcess.kill(); } catch { /* already dead */ }
    }
    if (recordingFile && fs.existsSync(recordingFile)) {
        try { fs.unlinkSync(recordingFile); } catch { /* ignore */ }
    }
}
