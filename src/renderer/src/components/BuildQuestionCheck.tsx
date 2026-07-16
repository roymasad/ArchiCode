import { AlertCircle, CheckCircle2, MessageSquare, Play, X } from "lucide-react";
import { useArchicodeStore } from "../store/useArchicodeStore";
import { Button, DialogContent, DialogRoot, StatusPill } from "./ui";

export function BuildQuestionCheck() {
  const {
    buildQuestionCheck,
    selectNode,
    dismissQuestionCheck,
    continueQuestionBlockedRun
  } = useArchicodeStore();

  return (
    <DialogRoot open={Boolean(buildQuestionCheck)} onOpenChange={(open) => {
      if (!open) dismissQuestionCheck();
    }}>
      {buildQuestionCheck ? (
        <DialogContent
          title="Questions Need Reply"
          description="The agent asked for input before coding. Resolve these node notes to keep the build grounded."
          className="question-check-modal"
        >
          <div className="question-check-list">
            {buildQuestionCheck.questions.map((question) => (
              <button
                key={question.noteId}
                type="button"
                className="question-check-item"
                onClick={() => {
                  selectNode(question.nodeId);
                  dismissQuestionCheck();
                }}
              >
                <div>
                  <MessageSquare size={16} />
                  <strong>{question.nodeTitle}</strong>
                </div>
                <p>{question.body}</p>
                <StatusPill tone="warning">open question</StatusPill>
              </button>
            ))}
          </div>
          <div className="question-check-note">
            <AlertCircle size={16} />
            <span>Build is paused so the LLM does not code from missing requirements. Continue only when you intentionally want it to proceed with current assumptions.</span>
          </div>
          <div className="dialog-actions">
            <Button type="button" onClick={dismissQuestionCheck}>
              <X size={16} />
              <span>Cancel</span>
            </Button>
            <Button
              type="button"
              onClick={() => {
                selectNode(buildQuestionCheck.questions[0]?.nodeId ?? null);
                dismissQuestionCheck();
              }}
            >
              <CheckCircle2 size={16} />
              <span>Review First</span>
            </Button>
            <Button type="button" variant="primary" onClick={() => void continueQuestionBlockedRun()}>
              <Play size={16} />
              <span>Continue Anyway</span>
            </Button>
          </div>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}
