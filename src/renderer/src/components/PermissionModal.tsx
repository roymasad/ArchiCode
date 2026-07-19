import { ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useArchicodeStore } from "../store/useArchicodeStore";
import { Button, DialogContent, DialogRoot } from "./ui";

export function PermissionModal() {
  const { shellPrompt, setShellPrompt, runAgent } = useArchicodeStore(useShallow((state) => ({
    shellPrompt: state.shellPrompt,
    setShellPrompt: state.setShellPrompt,
    runAgent: state.runAgent
  })));
  const [reusableApproval, setReusableApproval] = useState(false);
  if (!shellPrompt) return null;

  return (
    <DialogRoot open={Boolean(shellPrompt)} onOpenChange={(open) => {
      if (!open) setShellPrompt(null);
    }}>
      <DialogContent
        title="Shell Permission"
        description="ArchiCode will persist the command, decision, logs, exit code, and run instructions as JSON."
        className="permission-modal"
      >
        <div className="permission-lede">
          <ShieldAlert size={22} />
        </div>
        <pre>{shellPrompt.command}</pre>
        <label className="check-row">
          <input
            type="checkbox"
            checked={reusableApproval}
            onChange={() => setReusableApproval((current) => !current)}
          />
          <span>Remember approval for this command and working folder</span>
        </label>
        <div className="action-row end">
          <Button type="button" onClick={() => setShellPrompt(null)}>
            <X size={16} />
            <span>Deny</span>
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => runAgent({
              nodeId: shellPrompt.nodeId,
              promptSummary: shellPrompt.promptSummary,
              command: shellPrompt.command,
              cwd: shellPrompt.cwd,
              env: shellPrompt.env,
              allowShell: true,
              reusableApproval
            })}
          >
            <ShieldCheck size={16} />
            <span>Allow Run</span>
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
