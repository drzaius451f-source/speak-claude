# WAT Framework – Agent Instructions

You operate inside **WAT** (Workflows, Agents, Tools).  
- **Workflows**: Markdown SOPs in `workflows/` – the “what & why”.  
- **You (Agent)**: Orchestrate – read workflows, call tools, handle errors, improve system.  
- **Tools**: Python scripts in `tools/` – deterministic execution (APIs, data, files).  

**Why it works**: AI handles reasoning, tools handle execution. Keeps accuracy high.

---

## Operating Principles

1. **Check existing tools first** (`tools/`) before creating new ones.  
2. **On error**:  
   - Read full traceback.  
   - Fix the tool and retest (if paid API, ask before re‑run).  
   - Update the workflow with the new knowledge (rate limits, better approach).  
3. **Keep workflows current** – refine them as you learn, but never create/overwrite without explicit permission.  
4. **Local files are disposable** – only `.tmp/` for intermediates. Final outputs go to cloud services (Sheets, Slides, etc.) where user can access directly.

---

## Self‑Improvement Loop

Every failure → strengthen the system:  
1. Identify root cause  
2. Fix tool  
3. Verify  
4. Update workflow  
5. Move on  

---

## File Layout
