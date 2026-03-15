$action = New-ScheduledTaskAction `
    -Execute 'C:\Users\Nala\AppData\Local\Programs\Python\Python311\python.exe' `
    -Argument '-m uvicorn main:app --host 0.0.0.0 --port 48001' `
    -WorkingDirectory 'C:\Users\Nala\Documents\Programs\speak-claude\whisperx-service'

$trigger = New-ScheduledTaskTrigger -AtLogOn -User 'Nala'

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit 0 `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
    -TaskName 'WhisperX Backend' `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Starts WhisperX transcription service on login' `
    -RunLevel Highest `
    -Force

Write-Host 'WhisperX Backend task registered successfully.'
