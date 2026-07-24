import {
  AlertTriangle,
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
  Mic,
  MicOff,
  Monitor,
  Network,
  Play,
  RefreshCw,
  Route,
  ShieldCheck,
  Sparkles,
  Square,
  UserRound
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  codexRealtimeModels,
  codexRealtimeV2Voices,
  defaultAtlasRealtimeVoice,
  defaultCodexRealtimeModel,
  type ResearchChatSession
} from "@shared/schema";
import type {
  ProjectBriefing as ProjectBriefingDeck,
  ProjectBriefingAnswer,
  ProjectBriefingPreset,
  ProjectBriefingVisualItem
} from "@shared/projectBriefing";
import { t } from "../i18n";
import { useArchicodeStore } from "../store/useArchicodeStore";
import { Badge, Button, DialogContent, DialogRoot, TextInput, Tooltip } from "./ui";
import { OpenAiRealtimeCall, type RealtimeFunctionCall } from "./researchRealtime";

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
  const {
    rootPath,
    bundle,
    globalVoiceSettings,
    openProjectSettings
  } = useArchicodeStore(useShallow((state) => ({
    rootPath: state.rootPath,
    bundle: state.bundle,
    globalVoiceSettings: state.globalVoiceSettings,
    openProjectSettings: state.openProjectSettings
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
  const [regenerateConfirmation, setRegenerateConfirmation] = useState<ProjectBriefingDeck | null>(null);
  const [realtimeAvailability, setRealtimeAvailability] = useState<Awaited<ReturnType<typeof window.archicode.getCodexRealtimeStatus>> | null>(null);
  const [atlasSession, setAtlasSession] = useState<{
    error?: string | null;
    inputLevel: number;
    muted: boolean;
    researchSessionId: string;
    sessionId: string;
    status: "preparing" | "starting" | "hearing" | "listening" | "speaking" | "thinking" | "ended" | "error";
  } | null>(null);
  const [atlasLiveTurn, setAtlasLiveTurn] = useState<{ assistant?: string; user?: string } | null>(null);
  const atlasCallRef = useRef<OpenAiRealtimeCall | null>(null);
  const atlasStartGenerationRef = useRef(0);
  const atlasStartInFlightRef = useRef(false);
  const atlasIntroductionInProgressRef = useRef(false);
  const atlasIntroducedThisOpeningRef = useRef(false);
  const atlasConversationRef = useRef<ResearchChatSession | null>(null);
  const atlasResearchSessionIdRef = useRef<string | null>(null);
  const deckRef = useRef<ProjectBriefingDeck | null>(null);
  const slideIndexRef = useRef(0);
  const historyRef = useRef<QuestionHistory>([]);
  const slide = deck?.slides[slideIndex] ?? null;
  const progress = deck ? ((slideIndex + 1) / deck.slides.length) * 100 : 0;
  const preset = useMemo(() => presetCards.find((item) => item.preset === deck?.preset), [deck?.preset]);
  const generationStageIndex = Math.floor(generationSeconds / 3) % generationStages.length;
  const realtimeMode = globalVoiceSettings?.mode === "openai-realtime";
  const configuredRealtimeModel = globalVoiceSettings?.atlasRealtime.model
    && (codexRealtimeModels as readonly string[]).includes(globalVoiceSettings.atlasRealtime.model)
    ? globalVoiceSettings.atlasRealtime.model
    : defaultCodexRealtimeModel;
  const atlasLive = Boolean(atlasSession && atlasSession.status !== "ended" && atlasSession.status !== "error");
  const realtimeReady = realtimeMode && Boolean(realtimeAvailability?.realtimeAvailable);
  const atlasStatusLabel = atlasSession?.muted
    ? t("Muted")
    : atlasSession?.status === "speaking"
      ? t("Speaking")
      : atlasSession?.status === "thinking"
        ? t("Thinking")
        : atlasSession?.status === "hearing"
          ? t("Hearing you")
          : atlasSession?.status === "preparing" || atlasSession?.status === "starting"
            ? t("Connecting")
            : t("Listening");
  const realtimeSetupHint = !realtimeMode
    ? t("This briefing supports live discussion with Atlas. Enable OpenAI Realtime and add an API key in Voice settings.")
    : realtimeAvailability?.message
      ? t("Live discussion is not ready: {{message}}", { message: realtimeAvailability.message })
      : t("Checking OpenAI Realtime setup...");

  useEffect(() => {
    deckRef.current = deck;
  }, [deck]);

  useEffect(() => {
    slideIndexRef.current = slideIndex;
  }, [slideIndex]);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    if (!loadingPreset) {
      setGenerationSeconds(0);
      return;
    }
    const timer = window.setInterval(() => setGenerationSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [loadingPreset]);

  useEffect(() => {
    if (!deckOpen || !realtimeMode) {
      setRealtimeAvailability(null);
      return;
    }
    let cancelled = false;
    void window.archicode.getCodexRealtimeStatus(configuredRealtimeModel)
      .then((status) => {
        if (!cancelled) setRealtimeAvailability(status);
      })
      .catch((cause) => {
        if (!cancelled) {
          setRealtimeAvailability({
            available: true,
            command: "OpenAI API",
            message: cause instanceof Error ? cause.message : String(cause),
            realtimeAvailable: false
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [configuredRealtimeModel, deckOpen, realtimeMode]);

  const stopAtlas = useCallback(() => {
    atlasStartGenerationRef.current += 1;
    atlasStartInFlightRef.current = false;
    atlasIntroductionInProgressRef.current = false;
    atlasCallRef.current?.close();
    atlasCallRef.current = null;
    atlasResearchSessionIdRef.current = null;
    setAtlasSession((current) => current ? { ...current, inputLevel: 0, status: "ended" } : null);
  }, []);

  const closeAtlasOpening = useCallback(() => {
    stopAtlas();
    atlasConversationRef.current = null;
    atlasIntroducedThisOpeningRef.current = false;
  }, [stopAtlas]);

  useEffect(() => () => stopAtlas(), [stopAtlas]);

  const persistAtlasTurn = useCallback(async (
    researchSessionId: string,
    role: "user" | "assistant",
    text: string
  ) => {
    if (!rootPath || !text.trim()) return;
    const session = await window.archicode.appendResearchChatTranscript({
      projectRoot: rootPath,
      sessionId: researchSessionId,
      role,
      text
    });
    if (atlasConversationRef.current?.id === session.id) atlasConversationRef.current = session;
  }, [rootPath]);

  const ensureAtlasResearchSession = useCallback(async (currentDeck: ProjectBriefingDeck) => {
    if (!rootPath || !bundle) throw new Error("Open a project before talking with Atlas.");
    const existing = atlasConversationRef.current;
    if (
      existing?.origin?.type === "project-briefing"
      && existing.origin.briefingId === currentDeck.id
    ) return existing;
    atlasConversationRef.current = null;
    const session = await window.archicode.createResearchChat({
      projectRoot: rootPath,
      scope: { type: "project", projectId: bundle.project.id },
      origin: { type: "project-briefing", briefingId: currentDeck.id },
      title: `Atlas · ${currentDeck.title}`,
      providerId: bundle.project.settings.providers.find((provider) => provider.enabled)?.id
    });
    atlasConversationRef.current = session;
    return session;
  }, [bundle, rootPath]);

  const atlasBriefingInput = useCallback(() => {
    const currentDeck = deckRef.current;
    if (!currentDeck) return null;
    return {
      briefingId: currentDeck.id,
      history: historyRef.current,
      slideIndex: slideIndexRef.current
    };
  }, []);

  const atlasAuthoritativeViewContext = useCallback((reason: string) => {
    const currentDeck = deckRef.current;
    if (!currentDeck) return "";
    const currentIndex = Math.max(0, Math.min(currentDeck.slides.length - 1, slideIndexRef.current));
    const currentSlide = currentDeck.slides[currentIndex];
    if (!currentSlide) return "";
    return [
      "AUTHORITATIVE CURRENT BRIEFING VIEW — this supersedes every earlier slide or page reference in the conversation.",
      `Reason for refresh: ${reason}.`,
      `The user is visibly on slide ${currentIndex + 1} of ${currentDeck.slides.length}.`,
      `Visible slide id: ${currentSlide.id}.`,
      `Visible slide title: ${currentSlide.title}.`,
      JSON.stringify(currentSlide, null, 2),
      "Do not claim that another slide is visible. Do not speak merely because this context update arrived."
    ].join("\n\n");
  }, []);

  const handleAtlasFunctionCall = useCallback(async (call: RealtimeFunctionCall) => {
    const realtime = atlasCallRef.current;
    const researchSessionId = atlasResearchSessionIdRef.current;
    const briefing = atlasBriefingInput();
    if (!realtime || !rootPath || !researchSessionId || !briefing) return;
    try {
      if (call.name === "archicode_refresh_project_context") {
        const context = await window.archicode.getCodexRealtimeContext({
          briefing,
          model: configuredRealtimeModel,
          projectRoot: rootPath,
          researchSessionId,
          surface: "briefing-curator"
        });
        realtime.sendFunctionOutput(call.callId, { context });
        return;
      }
      if ([
        "archicode_read_research_context",
        "archicode_read_chat_history",
        "archicode_search_previous_chats",
        "archicode_project_list_files",
        "archicode_project_search_files",
        "archicode_project_read_file",
        "archicode_project_query_code_graph"
      ].includes(call.name)) {
        const resultText = await window.archicode.callCodexRealtimeReadTool({
          argumentsJson: call.argumentsJson || "{}",
          model: configuredRealtimeModel,
          projectRoot: rootPath,
          providerToolName: call.name,
          researchSessionId
        });
        let result: unknown = resultText;
        try {
          result = JSON.parse(resultText);
        } catch {
          // Fuller graph and context reads may intentionally return formatted text.
        }
        realtime.sendFunctionOutput(call.callId, { result });
        return;
      }
      throw new Error(`Atlas cannot use ${call.name} in read-only briefing mode.`);
    } catch (cause) {
      realtime.sendFunctionOutput(call.callId, {
        error: cause instanceof Error ? cause.message : "Atlas could not complete that read-only lookup."
      });
    }
  }, [atlasBriefingInput, configuredRealtimeModel, rootPath]);

  const startAtlas = useCallback(async () => {
    const currentDeck = deckRef.current;
    if (
      atlasStartInFlightRef.current
      || atlasCallRef.current
      || !rootPath
      || !bundle
      || !currentDeck
      || !realtimeReady
      || !globalVoiceSettings
    ) return;
    atlasStartInFlightRef.current = true;
    const generation = atlasStartGenerationRef.current + 1;
    atlasStartGenerationRef.current = generation;
    const isCurrent = () => atlasStartGenerationRef.current === generation;
    let call: OpenAiRealtimeCall | null = null;
    try {
      setAtlasLiveTurn(null);
      setAtlasSession({
        inputLevel: 0,
        muted: false,
        researchSessionId: "",
        sessionId: "starting",
        status: "preparing"
      });
      const researchSession = await ensureAtlasResearchSession(currentDeck);
      if (!isCurrent()) return;
      atlasResearchSessionIdRef.current = researchSession.id;
      const voice = globalVoiceSettings.atlasRealtime.voice
        && (codexRealtimeV2Voices as readonly string[]).includes(globalVoiceSettings.atlasRealtime.voice)
        ? globalVoiceSettings.atlasRealtime.voice
        : defaultAtlasRealtimeVoice;
      const briefing = atlasBriefingInput();
      if (!briefing) throw new Error("Atlas could not read the active briefing.");
      const secret = await window.archicode.startCodexRealtime({
        briefing,
        includeStartupContext: true,
        model: configuredRealtimeModel,
        outputModality: globalVoiceSettings.codexRealtime.outputModality,
        projectRoot: rootPath,
        researchSessionId: researchSession.id,
        surface: "briefing-curator",
        voice
      });
      if (!isCurrent()) return;
      const sessionId = secret.sessionId ?? window.crypto.randomUUID();
      call = new OpenAiRealtimeCall({
        onAssistantTranscript: (text) => {
          if (!isCurrent()) return;
          setAtlasLiveTurn((current) => ({ ...current, assistant: text }));
          void persistAtlasTurn(researchSession.id, "assistant", text);
        },
        onError: (message) => {
          if (!isCurrent()) return;
          atlasCallRef.current?.close();
          atlasCallRef.current = null;
          setAtlasSession((current) => current ? { ...current, error: message, status: "error" } : current);
        },
        onFunctionCall: (functionCall) => {
          if (isCurrent()) void handleAtlasFunctionCall(functionCall);
        },
        onInputLevel: (inputLevel) => {
          if (isCurrent()) setAtlasSession((current) => current ? { ...current, inputLevel } : current);
        },
        onSessionCreated: () => undefined,
        onStatus: (status) => {
          if (!isCurrent()) return;
          if (status === "listening" && atlasIntroductionInProgressRef.current) {
            atlasIntroductionInProgressRef.current = false;
            atlasCallRef.current?.setMuted(false);
            setAtlasSession((current) => current ? { ...current, inputLevel: 0, muted: false, status } : current);
            return;
          }
          setAtlasSession((current) => current ? { ...current, status } : current);
        },
        onUserTranscript: (text) => {
          if (!isCurrent()) return;
          const viewContext = atlasAuthoritativeViewContext("the user just spoke");
          if (viewContext) atlasCallRef.current?.appendDeveloperContext(viewContext, false);
          setAtlasLiveTurn({ user: text });
          void persistAtlasTurn(researchSession.id, "user", text);
        }
      });
      atlasCallRef.current = call;
      setAtlasSession({
        inputLevel: 0,
        muted: false,
        researchSessionId: researchSession.id,
        sessionId,
        status: "starting"
      });
      await call.connect(secret);
      if (!isCurrent()) return;
      const viewContext = atlasAuthoritativeViewContext("the live session has connected");
      if (viewContext) call.appendDeveloperContext(viewContext, false);
      if (!atlasIntroducedThisOpeningRef.current) {
        atlasIntroducedThisOpeningRef.current = true;
        atlasIntroductionInProgressRef.current = true;
        call.setMuted(true);
        setAtlasSession((current) => current ? { ...current, inputLevel: 0, muted: true } : current);
        call.appendDeveloperContext([
          "Give the opening introduction exactly once now.",
          "Use two or three concise, natural sentences.",
          "Introduce yourself as Atlas, the project curator.",
          `Name the open project briefing: ${currentDeck.title}.`,
          `Its subtitle is: ${currentDeck.subtitle}.`,
          `The project is: ${bundle.project.name}.`,
          "Briefly explain what this presentation will help the user understand, grounded in the briefing title, subtitle, and deck.",
          "Invite the user to interrupt or ask questions.",
          "Do not start narrating the current slide, and do not send a second greeting."
        ].join("\n"), true);
      }
    } catch (cause) {
      if (atlasIntroductionInProgressRef.current) {
        atlasIntroductionInProgressRef.current = false;
        atlasIntroducedThisOpeningRef.current = false;
      }
      call?.close();
      if (atlasCallRef.current === call) atlasCallRef.current = null;
      if (!isCurrent()) return;
      setAtlasSession((current) => ({
        error: cause instanceof Error ? cause.message : "Could not start Atlas.",
        inputLevel: 0,
        muted: false,
        researchSessionId: current?.researchSessionId ?? "",
        sessionId: current?.sessionId ?? "error",
        status: "error"
      }));
    } finally {
      if (isCurrent()) atlasStartInFlightRef.current = false;
    }
  }, [
    atlasAuthoritativeViewContext,
    atlasBriefingInput,
    bundle,
    configuredRealtimeModel,
    ensureAtlasResearchSession,
    globalVoiceSettings,
    handleAtlasFunctionCall,
    persistAtlasTurn,
    realtimeReady,
    rootPath
  ]);

  const toggleAtlasMute = useCallback(() => {
    const call = atlasCallRef.current;
    if (!call) return;
    const muted = !call.isMuted();
    call.setMuted(muted);
    setAtlasSession((current) => current ? {
      ...current,
      inputLevel: muted ? 0 : current.inputLevel,
      muted
    } : current);
  }, []);

  useEffect(() => {
    const call = atlasCallRef.current;
    if (!call || !atlasLive) return;
    const viewContext = atlasAuthoritativeViewContext(
      showEvidence ? "the user changed slides or opened the evidence panel" : "the user changed slides or closed the evidence panel"
    );
    if (viewContext) call.appendDeveloperContext(viewContext, false);
  }, [atlasAuthoritativeViewContext, atlasLive, showEvidence, slideIndex]);

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
    closeAtlasOpening();
    deckRef.current = savedDeck;
    slideIndexRef.current = 0;
    historyRef.current = [];
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
    const boundedIndex = Math.max(0, Math.min(deck.slides.length - 1, nextIndex));
    slideIndexRef.current = boundedIndex;
    setSlideIndex(boundedIndex);
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
      const nextHistory = [...history, { question: nextQuestion, answer: nextAnswer.answer }].slice(-6);
      historyRef.current = nextHistory;
      setHistory(nextHistory);
      atlasCallRef.current?.appendDeveloperContext([
        "The user asked a typed question in the briefing and received this evidence-grounded answer from the read-only curator.",
        `Question: ${nextQuestion}`,
        `Answer: ${nextAnswer.answer}`,
        `Evidence: ${JSON.stringify(nextAnswer.evidence)}`,
        "Treat this as part of the same conversation. Do not speak now; use it if the user follows up."
      ].join("\n\n"), false);
      const researchSessionId = atlasResearchSessionIdRef.current;
      if (researchSessionId) {
        void (async () => {
          await persistAtlasTurn(researchSessionId, "user", nextQuestion);
          await persistAtlasTurn(researchSessionId, "assistant", nextAnswer.answer);
        })();
      }
      setQuestion("");
    } catch (cause) {
      setQuestionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAsking(false);
    }
  };

  const confirmRegenerateDeck = () => {
    const confirmation = regenerateConfirmation;
    if (!confirmation) return;
    closeAtlasOpening();
    const selectedPreset = confirmation.preset;
    setRegenerateConfirmation(null);
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
          title={t("Hi! I’m Atlas, your curator. How should I brief you?")}
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
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => setRegenerateConfirmation(savedDeck)}
                          >
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

      <DialogRoot open={deckOpen} onOpenChange={(open) => {
        if (!open) closeAtlasOpening();
        setDeckOpen(open);
      }}>
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
                {atlasLive ? (
                  <div className="project-briefing-atlas-controls">
                    <span className={`project-briefing-atlas-status status-${atlasSession?.status ?? "listening"}`}>
                      <i style={{ "--atlas-input-level": atlasSession?.inputLevel ?? 0 } as CSSProperties} />
                      {atlasStatusLabel}
                    </span>
                    <Tooltip content={atlasSession?.muted ? t("Unmute microphone") : t("Mute microphone")}>
                      <Button type="button" size="sm" onClick={toggleAtlasMute} aria-pressed={Boolean(atlasSession?.muted)}>
                        {atlasSession?.muted ? <MicOff size={15} /> : <Mic size={15} />}
                      </Button>
                    </Tooltip>
                    <Tooltip content={t("End the live conversation with Atlas.")}>
                      <Button type="button" size="sm" variant="danger" onClick={stopAtlas}>
                        <Square size={14} />
                        {t("End live")}
                      </Button>
                    </Tooltip>
                  </div>
                ) : realtimeReady ? (
                  <Tooltip content={t("Talk with Atlas about this briefing and the wider project.")}>
                    <Button type="button" size="sm" variant="primary" onClick={() => void startAtlas()}>
                      <Mic size={15} />
                      {t("Talk with Atlas")}
                    </Button>
                  </Tooltip>
                ) : (
                  <Tooltip content={realtimeSetupHint}>
                    <Button
                      type="button"
                      size="sm"
                      className="project-briefing-atlas-unavailable"
                      onClick={() => openProjectSettings("advanced")}
                      aria-label={t("Set up live discussion with Atlas")}
                    >
                      <MicOff size={15} />
                      {t("Live discussion")}
                    </Button>
                  </Tooltip>
                )}
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setRegenerateConfirmation(deck)}
                  disabled={Boolean(exporting) || asking}
                >
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

                {atlasSession && atlasSession.status !== "ended" ? (
                  <section className={`project-briefing-atlas-presence${atlasSession.status === "error" ? " is-error" : ""}`} aria-live="polite">
                    <header>
                      <span><Mic size={15} /> {t("Atlas · Project curator")}</span>
                      <small>{atlasSession.status === "error" ? t("Connection ended") : atlasStatusLabel}</small>
                    </header>
                    {atlasLiveTurn?.user ? (
                      <div>
                        <small>{t("You")}</small>
                        <p>{atlasLiveTurn.user}</p>
                      </div>
                    ) : null}
                    {atlasLiveTurn?.assistant ? (
                      <div className="is-atlas">
                        <small>{t("Atlas")}</small>
                        <p>{atlasLiveTurn.assistant}</p>
                      </div>
                    ) : null}
                    {atlasSession.error ? <p className="project-briefing-error">{atlasSession.error}</p> : null}
                  </section>
                ) : null}

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
                onClick={() => {
                  if (slideIndex === deck.slides.length - 1) {
                    closeAtlasOpening();
                    setDeckOpen(false);
                  } else {
                    moveTo(slideIndex + 1);
                  }
                }}
                disabled={asking}
              >
                {slideIndex === deck.slides.length - 1 ? t("Finish") : t("Next")}
                {slideIndex === deck.slides.length - 1 ? <Sparkles size={17} /> : <ChevronRight size={17} />}
              </Button>
            </footer>
          </DialogContent>
        ) : null}
      </DialogRoot>

      <DialogRoot
        open={Boolean(regenerateConfirmation)}
        onOpenChange={(open) => {
          if (!open && !loadingPreset) setRegenerateConfirmation(null);
        }}
      >
        {regenerateConfirmation ? (
          <DialogContent
            className="project-briefing-regenerate-confirm"
            title={t("Regenerate this briefing?")}
            description={t("This will replace the saved {{preset}} briefing.", {
              preset: t(presetCards.find((item) => item.preset === regenerateConfirmation.preset)?.title ?? "Project briefing")
            })}
          >
            <div className="confirm-summary">
              <div className="confirm-summary-grid">
                <span>
                  <b>{t("Saved briefing")}</b>
                  {regenerateConfirmation.title}
                </span>
                <span>
                  <b>{t("Effect")}</b>
                  {t("The current saved presentation will be permanently replaced.")}
                </span>
              </div>
              <p className="confirm-note">
                <AlertTriangle size={15} />
                {t("Downloaded PDF or PowerPoint files are not affected. The existing Atlas conversation stays in Research history but will not be linked to the new briefing.")}
              </p>
            </div>
            <div className="dialog-actions">
              <Button type="button" onClick={() => setRegenerateConfirmation(null)}>
                {t("Cancel")}
              </Button>
              <Button type="button" variant="danger" onClick={confirmRegenerateDeck}>
                <RefreshCw size={15} />
                {t("Regenerate and replace")}
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </DialogRoot>
    </>
  );
}
