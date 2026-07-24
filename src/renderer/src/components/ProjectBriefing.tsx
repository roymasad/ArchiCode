import {
  ArrowRight,
  BookOpen,
  Box,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Database,
  Download,
  FileText,
  Loader2,
  MessageCircleQuestion,
  Monitor,
  Network,
  Play,
  RefreshCw,
  Route,
  ShieldCheck,
  Sparkles,
  UserRound
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import type {
  ProjectBriefing as ProjectBriefingDeck,
  ProjectBriefingAnswer,
  ProjectBriefingPreset,
  ProjectBriefingVisualItem
} from "@shared/projectBriefing";
import { t } from "../i18n";
import { useArchicodeStore } from "../store/useArchicodeStore";
import { Badge, Button, DialogContent, DialogRoot, TextInput, Tooltip } from "./ui";

type QuestionHistory = Array<{ question: string; answer: string }>;

const presetCards: Array<{
  preset: ProjectBriefingPreset;
  title: string;
  duration: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    preset: "simple",
    title: "Explain it simply",
    duration: "~3 min",
    description: "The friendly, non-technical version: who it helps, what it does, and how the pieces cooperate.",
    icon: <Sparkles size={24} />
  },
  {
    preset: "quick",
    title: "Put me up to speed",
    duration: "~2 min",
    description: "The shortest useful mental model for a busy developer joining the conversation.",
    icon: <Route size={24} />
  },
  {
    preset: "onboarding",
    title: "Project onboarding",
    duration: "~5 min",
    description: "A practical tour from product purpose to architecture, vocabulary, and where to begin.",
    icon: <BookOpen size={24} />
  }
];

const generationStages = [
  { label: "Reading the project signals", icon: <Network size={22} /> },
  { label: "Following the important paths", icon: <Route size={22} /> },
  { label: "Checking the evidence", icon: <ShieldCheck size={22} /> },
  { label: "Turning facts into a story", icon: <BookOpen size={22} /> },
  { label: "Polishing the cards", icon: <Sparkles size={22} /> }
];

function itemIcon(kind: ProjectBriefingVisualItem["kind"]): ReactNode {
  if (kind === "person") return <UserRound size={24} />;
  if (kind === "screen") return <Monitor size={24} />;
  if (kind === "data") return <Database size={24} />;
  if (kind === "service") return <Box size={24} />;
  if (kind === "system") return <Network size={24} />;
  if (kind === "step") return <Route size={24} />;
  return <Sparkles size={24} />;
}

function BriefingVisual({ slide }: { slide: ProjectBriefingDeck["slides"][number] }) {
  const visual = slide.visual;
  return (
    <div className={`project-briefing-visual project-briefing-visual-${visual.kind}`}>
      <div className="project-briefing-visual-orbit project-briefing-visual-orbit-one" />
      <div className="project-briefing-visual-orbit project-briefing-visual-orbit-two" />
      <div className="project-briefing-visual-items">
        {visual.items.map((item, index) => (
          <div className="project-briefing-visual-step" key={item.id}>
            <article className={`project-briefing-visual-card tone-${item.tone}`}>
              <span className="project-briefing-visual-icon">{itemIcon(item.kind)}</span>
              <strong>{item.label}</strong>
              {item.detail ? <small>{item.detail}</small> : null}
            </article>
            {index < visual.items.length - 1 && visual.kind !== "map" ? (
              <ArrowRight className="project-briefing-visual-arrow" size={22} aria-hidden="true" />
            ) : null}
          </div>
        ))}
      </div>
      {visual.connections.length ? (
        <div className="project-briefing-connection-list" aria-label={t("Visual relationships")}>
          {visual.connections.map((connection) => {
            const from = visual.items.find((item) => item.id === connection.from)?.label ?? connection.from;
            const to = visual.items.find((item) => item.id === connection.to)?.label ?? connection.to;
            return (
              <span key={`${connection.from}-${connection.to}-${connection.label ?? ""}`}>
                {from} <ArrowRight size={12} /> {connection.label ? <b>{connection.label}</b> : null} {to}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function EvidenceList({ evidence }: { evidence: ProjectBriefingDeck["slides"][number]["evidence"] }) {
  return (
    <div className="project-briefing-evidence-list">
      {evidence.map((item, index) => (
        <article key={`${item.reference}-${index}`}>
          <div>
            <ShieldCheck size={15} />
            <strong>{item.label}</strong>
          </div>
          <p>{item.excerpt}</p>
          <code>{item.reference}</code>
        </article>
      ))}
    </div>
  );
}

export function ProjectBriefing() {
  const { rootPath, bundle } = useArchicodeStore(useShallow((state) => ({
    rootPath: state.rootPath,
    bundle: state.bundle
  })));
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [deckOpen, setDeckOpen] = useState(false);
  const [loadingPreset, setLoadingPreset] = useState<ProjectBriefingPreset | null>(null);
  const [generationSeconds, setGenerationSeconds] = useState(0);
  const [savedDecks, setSavedDecks] = useState<ProjectBriefingDeck[]>([]);
  const [loadingSaved, setLoadingSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deck, setDeck] = useState<ProjectBriefingDeck | null>(null);
  const [slideIndex, setSlideIndex] = useState(0);
  const [showEvidence, setShowEvidence] = useState(false);
  const [question, setQuestion] = useState("");
  const [activeQuestion, setActiveQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState<ProjectBriefingAnswer | null>(null);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [exporting, setExporting] = useState<"pdf" | "pptx" | null>(null);
  const [history, setHistory] = useState<QuestionHistory>([]);
  const slide = deck?.slides[slideIndex] ?? null;
  const progress = deck ? ((slideIndex + 1) / deck.slides.length) * 100 : 0;
  const preset = useMemo(() => presetCards.find((item) => item.preset === deck?.preset), [deck?.preset]);
  const generationStageIndex = Math.floor(generationSeconds / 3) % generationStages.length;

  useEffect(() => {
    if (!loadingPreset) {
      setGenerationSeconds(0);
      return;
    }
    const timer = window.setInterval(() => setGenerationSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [loadingPreset]);

  const openLauncher = async () => {
    if (!rootPath) return;
    setError(null);
    setLauncherOpen(true);
    setLoadingSaved(true);
    try {
      setSavedDecks(await window.archicode.listProjectBriefings(rootPath));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingSaved(false);
    }
  };

  const openDeck = (savedDeck: ProjectBriefingDeck) => {
    setDeck(savedDeck);
    setSlideIndex(0);
    setShowEvidence(false);
    setAnswer(null);
    setActiveQuestion(null);
    setHistory([]);
    setLauncherOpen(false);
    setDeckOpen(true);
  };

  const startBriefing = async (selectedPreset: ProjectBriefingPreset) => {
    if (!rootPath) return;
    setLoadingPreset(selectedPreset);
    setError(null);
    try {
      const nextDeck = await window.archicode.generateProjectBriefing(rootPath, selectedPreset);
      setSavedDecks((items) => [nextDeck, ...items.filter((item) => item.preset !== nextDeck.preset)]);
      openDeck(nextDeck);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingPreset(null);
    }
  };

  const moveTo = (nextIndex: number) => {
    if (!deck) return;
    setSlideIndex(Math.max(0, Math.min(deck.slides.length - 1, nextIndex)));
    setShowEvidence(false);
    setAnswer(null);
    setActiveQuestion(null);
    setQuestionError(null);
    setQuestion("");
  };

  const askQuestion = async (event: FormEvent, suggestedQuestion?: string) => {
    event.preventDefault();
    if (!rootPath || !deck || !slide) return;
    const nextQuestion = (suggestedQuestion ?? question).trim();
    if (!nextQuestion) return;
    setActiveQuestion(nextQuestion);
    setAsking(true);
    setQuestionError(null);
    try {
      const nextAnswer = await window.archicode.askProjectBriefingQuestion(rootPath, {
        deck,
        slideIndex,
        question: nextQuestion,
        history
      });
      setAnswer(nextAnswer);
      setHistory((items) => [...items, { question: nextQuestion, answer: nextAnswer.answer }].slice(-6));
      setQuestion("");
    } catch (cause) {
      setQuestionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAsking(false);
    }
  };

  const regenerateDeck = () => {
    if (!deck) return;
    const selectedPreset = deck.preset;
    setDeckOpen(false);
    setLauncherOpen(true);
    void startBriefing(selectedPreset);
  };

  const downloadDeck = async (format: "pdf" | "pptx") => {
    if (!rootPath || !deck) return;
    setExporting(format);
    setQuestionError(null);
    try {
      await window.archicode.exportProjectBriefing(rootPath, deck.id, format);
    } catch (cause) {
      setQuestionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExporting(null);
    }
  };

  return (
    <>
      <Tooltip content={t("Create a short, evidence-grounded visual introduction to this project.")}>
        <span className="project-briefing-sidebar-tooltip">
          <Button
            type="button"
            variant="primary"
            className="project-briefing-trigger"
            onClick={() => void openLauncher()}
            disabled={!bundle || !rootPath}
          >
            <BookOpen size={16} />
            <span>{t("Brief me")}</span>
          </Button>
        </span>
      </Tooltip>

      <DialogRoot open={launcherOpen} onOpenChange={(open) => !loadingPreset && setLauncherOpen(open)}>
        <DialogContent
          className="project-briefing-launcher"
          title={t("Hi! I’m Archi. How should I brief you?")}
          description={t("Choose a pace. I’ll investigate read-only project evidence and curate a small visual story.")}
        >
          {loadingPreset ? (
            <section className="project-briefing-generation" aria-live="polite">
              <div className="project-briefing-generation-scene" aria-hidden="true">
                <span className="project-briefing-generation-core"><BookOpen size={30} /></span>
                <span className="project-briefing-generation-satellite satellite-one"><Network size={18} /></span>
                <span className="project-briefing-generation-satellite satellite-two"><ShieldCheck size={18} /></span>
                <span className="project-briefing-generation-satellite satellite-three"><Sparkles size={18} /></span>
              </div>
              <div className="project-briefing-generation-copy">
                <span>{t("Curating your briefing...")}</span>
                <h3>{t(generationStages[generationStageIndex].label)}</h3>
                <p>{t("Still working - {{seconds}}s", { seconds: generationSeconds })}</p>
              </div>
              <div className="project-briefing-generation-steps">
                {generationStages.map((stage, index) => (
                  <div className={index === generationStageIndex ? "is-active" : ""} key={stage.label}>
                    <span>{stage.icon}</span>
                    <small>{t(stage.label)}</small>
                  </div>
                ))}
              </div>
            </section>
          ) : (
            <div className="project-briefing-preset-grid">
              {presetCards.map((card) => {
                const savedDeck = savedDecks.find((item) => item.preset === card.preset);
                return (
                  <article className="project-briefing-preset-card" key={card.preset}>
                    <span className="project-briefing-preset-icon">{card.icon}</span>
                    <span>
                      <strong>{t(card.title)}</strong>
                      <small>{t(card.duration)}</small>
                    </span>
                    <p>{t(card.description)}</p>
                    <div className="project-briefing-preset-actions">
                      {savedDeck ? (
                        <>
                          <Button type="button" size="sm" variant="primary" onClick={() => openDeck(savedDeck)}>
                            <Play size={15} />
                            {t("Open saved")}
                          </Button>
                          <Button type="button" size="sm" onClick={() => void startBriefing(card.preset)}>
                            <RefreshCw size={15} />
                            {t("Regenerate")}
                          </Button>
                        </>
                      ) : (
                        <Button type="button" size="sm" variant="primary" onClick={() => void startBriefing(card.preset)} disabled={loadingSaved}>
                          {loadingSaved ? <Loader2 className="spin" size={15} /> : <Play size={15} />}
                          {t("Generate")}
                        </Button>
                      )}
                    </div>
                    {savedDeck ? (
                      <small className="project-briefing-saved-at">
                        {t("Saved {{date}}", { date: new Date(savedDeck.generatedAt).toLocaleString() })}
                      </small>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
          <div className="project-briefing-safety-note">
            <ShieldCheck size={17} />
            <span>{t("Read-only and evidence-grounded curation. I can’t change files, run commands, or edit your graph in this mode.")}</span>
          </div>
          {error ? <p className="project-briefing-error">{error}</p> : null}
        </DialogContent>
      </DialogRoot>

      <DialogRoot open={deckOpen} onOpenChange={setDeckOpen}>
        {deck && slide ? (
          <DialogContent
            className="project-briefing-deck"
            title={deck.title}
            description={`${preset ? t(preset.title) : t("Project briefing")} · ${deck.subtitle}`}
          >
            <div className="project-briefing-progress" aria-label={t("Slide {{current}} of {{total}}", { current: slideIndex + 1, total: deck.slides.length })}>
              <span style={{ width: `${progress}%` }} />
            </div>
            <div className="project-briefing-deck-tools">
              <span><ShieldCheck size={14} /> {t("Saved in this project")}</span>
              <div>
                <Button type="button" size="sm" onClick={regenerateDeck} disabled={Boolean(exporting) || asking}>
                  <RefreshCw size={15} />
                  {t("Regenerate")}
                </Button>
                <Button type="button" size="sm" onClick={() => void downloadDeck("pdf")} disabled={Boolean(exporting)}>
                  {exporting === "pdf" ? <Loader2 className="spin" size={15} /> : <FileText size={15} />}
                  {t("PDF")}
                </Button>
                <Button type="button" size="sm" onClick={() => void downloadDeck("pptx")} disabled={Boolean(exporting)}>
                  {exporting === "pptx" ? <Loader2 className="spin" size={15} /> : <Download size={15} />}
                  {t("PowerPoint")}
                </Button>
              </div>
            </div>

            <main className="project-briefing-stage">
              <BriefingVisual slide={slide} />
              <section className="project-briefing-story">
                <div className="project-briefing-kicker">
                  <Badge tone="accent">{slide.kicker}</Badge>
                  <span>{t("{{current}} of {{total}}", { current: slideIndex + 1, total: deck.slides.length })}</span>
                </div>
                <h2>{slide.title}</h2>
                <p>{slide.body}</p>

                {answer ? (
                  <section className="project-briefing-answer" aria-live="polite">
                    <div>
                      <MessageCircleQuestion size={18} />
                      <strong>{t("Briefing paused")}</strong>
                    </div>
                    {activeQuestion ? (
                      <div className="project-briefing-answer-question">
                        <small>{t("You asked")}</small>
                        <q>{activeQuestion}</q>
                      </div>
                    ) : null}
                    <p>{answer.answer}</p>
                    <EvidenceList evidence={answer.evidence} />
                    <Button type="button" variant="primary" onClick={() => {
                      setAnswer(null);
                      setActiveQuestion(null);
                    }}>
                      <Play size={16} />
                      {t("Continue briefing")}
                    </Button>
                  </section>
                ) : (
                  <>
                    <div className="project-briefing-story-actions">
                      <Button type="button" size="sm" variant={showEvidence ? "primary" : "secondary"} onClick={() => setShowEvidence((value) => !value)}>
                        <ShieldCheck size={16} />
                        {showEvidence ? t("Hide evidence") : t("Show evidence")}
                        <Badge tone="neutral">{slide.evidence.length}</Badge>
                      </Button>
                    </div>
                    {showEvidence ? <EvidenceList evidence={slide.evidence} /> : null}
                    <form className="project-briefing-question" onSubmit={(event) => void askQuestion(event)}>
                      <label htmlFor="project-briefing-question">
                        <CircleHelp size={16} />
                        {t("Pause and ask about this")}
                      </label>
                      <div>
                        <TextInput
                          id="project-briefing-question"
                          value={question}
                          onChange={(event) => setQuestion(event.target.value)}
                          placeholder={t("What does this mean for me?")}
                          disabled={asking}
                        />
                        <Button type="submit" variant="primary" disabled={asking || !question.trim()}>
                          {asking ? <Loader2 className="spin" size={16} /> : <MessageCircleQuestion size={16} />}
                          {t("Ask")}
                        </Button>
                      </div>
                      {slide.suggestedQuestions.length ? (
                        <div className="project-briefing-question-suggestions">
                          {slide.suggestedQuestions.map((suggestion) => (
                            <button
                              type="button"
                              key={suggestion}
                              onClick={(event) => void askQuestion(event, suggestion)}
                              disabled={asking}
                            >
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {asking ? (
                        <div className="project-briefing-question-thinking" aria-live="polite">
                          <span className="project-briefing-thinking-route" aria-hidden="true">
                            <i />
                            <i />
                            <i />
                          </span>
                          <span>
                            <strong>{t("Following the evidence")}</strong>
                            <small>{activeQuestion}</small>
                          </span>
                        </div>
                      ) : null}
                      {questionError ? <p className="project-briefing-error">{questionError}</p> : null}
                    </form>
                  </>
                )}
              </section>
            </main>

            <footer className="project-briefing-footer">
              <Button type="button" onClick={() => moveTo(slideIndex - 1)} disabled={slideIndex === 0 || asking}>
                <ChevronLeft size={17} />
                {t("Previous")}
              </Button>
              <div>
                <span>{slide.kicker}</span>
                <div className="project-briefing-dots" aria-hidden="true">
                  {deck.slides.map((item, index) => (
                    <button
                      type="button"
                      className={index === slideIndex ? "is-active" : ""}
                      key={item.id}
                      onClick={() => moveTo(index)}
                      tabIndex={-1}
                    />
                  ))}
                </div>
              </div>
              <Button
                type="button"
                variant="primary"
                onClick={() => slideIndex === deck.slides.length - 1 ? setDeckOpen(false) : moveTo(slideIndex + 1)}
                disabled={asking}
              >
                {slideIndex === deck.slides.length - 1 ? t("Finish") : t("Next")}
                {slideIndex === deck.slides.length - 1 ? <Sparkles size={17} /> : <ChevronRight size={17} />}
              </Button>
            </footer>
          </DialogContent>
        ) : null}
      </DialogRoot>
    </>
  );
}
