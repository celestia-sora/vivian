"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { captureModelRestState, restoreModelRestState, type ModelRestState, type CubismRestModel } from "@/lib/model-rest-state";
import { attachModelWind, type WindInternalModel } from "@/lib/model-wind";
import { clampModelTransform, clearModelTransform, loadModelTransform, saveModelTransform, type ModelTransform } from "@/lib/model-position";
import { preloadLive2DModules, waitForCubismCore } from "@/lib/model-runtime";
import { loadModelPreviews, removeModelPreview, saveModelPreview } from "@/lib/model-preview-cache";
import { faceCrop, SNAPSHOT_PREVIEW_PATH, snapshotToBlob } from "@/lib/model-snapshot";
import { scheduleBackgroundWork } from "@/lib/startup-background";
import { readChatResponse } from "@/lib/chat-stream";
import { startTiming, finishTiming, cancelTiming, type LocalTiming } from "@/lib/performance";
import { shouldPauseModelStartup, clearModelLoadState } from "@/lib/model-startup";
import { singleFlightModel, preloadModelPackages } from "@/lib/model-preload";
import { subscribeModelLibrary } from "@/lib/model-library-realtime";
import { useConversationHistory } from "@/lib/use-conversation-history";
import { historyMessage, HISTORY_CACHE_KEY, type HistoryMessage, type HistoryConversation } from "@/lib/chat-history";
import { authFetch } from "@/lib/auth/fetch";
import { decayCompanionState, type CompanionState, defaultCompanionState, normalizeMood, moodLabel, type Mood } from "@/lib/companion";
import { detectLive2DEmotion, resolveLive2DExpression, resolveLive2DMotion } from "@/lib/live2d-emotion";
import { createExpressionStack, loadExpressionParameterSets, SAVED_EXPRESSION_STACK_FILE, SAVED_EXPRESSION_STACK_NAME } from "@/lib/live2d-expression-stack";
import { MODEL_CONFIG, type ModelKey } from "@/lib/models";
import { createModelResources, importModelFiles, loadModelCatalog, hydrateModelPackage, modelCatalogEntry, readModelSelection, resolveStartupModel, writeModelSelection, removeModelPackage, saveModelPackage, type ModelPackage, type ModelMotion } from "@/lib/local-models";
import { getCloudModels, cloudModelPlaceholder, uploadCloudModel, downloadCloudModel, deleteCloudModel, saveCloudModelPreference, saveCloudModelExpressions, type CloudLibrary } from "@/lib/cloud-models";
import { useVoicePreferences } from "@/lib/use-voice-preferences";
import { useCustomInstructions } from "@/lib/use-custom-instructions";
import type { SpeechLanguage } from "@/lib/voice-preferences";
import { useSceneLibrary } from "@/lib/use-scene-library";
import { SceneManager } from "@/app/components/scene-manager";
import { SceneBackground } from "@/app/components/scene-background";
import { StorageStatusPanel } from "@/app/components/storage-status";
import { createVoiceActivity, updateVoiceActivity, type VoiceActivityState } from "@/lib/voice-activity";
import type { SceneDecision } from "@/lib/scenes";
import { useMotionValue } from "motion/react";
import SiriOrb from "@/components/ui/smoothui/siri-orb";
import AnimatedFileUpload from "@/components/ui/smoothui/animated-file-upload";
import CoverflowCarousel, { type CoverflowCarouselItem } from "@/components/ui/smoothui/coverflow-carousel";
import type { AIState } from "@/components/ui/smoothui/ai-core";
import PagePreloader from "@/components/ui/smoothui/page-preloader";

async function availableModelPackage(pack: ModelPackage, cloud: CloudLibrary | Promise<CloudLibrary | null> | null, signal?: AbortSignal): Promise<ModelPackage | undefined> {
  return singleFlightModel(pack.id, (sharedSignal) => hydrateModelPackage(pack, {
    signal: sharedSignal,
    recover: cloud ? async () => {
      // A readable local cache never waits for the cloud request.
      const library = await cloud;
      sharedSignal.throwIfAborted();
      const remote = library?.models.find((model) => model.id === pack.id);
      if (!remote || !library) throw new Error("Model files are unavailable on this device. Reconnect to the cloud or import the original model again.");
      const downloaded = await downloadCloudModel(remote, library.userId, sharedSignal);
      await saveModelPackage(downloaded).catch(() => {});
      return downloaded;
    } : undefined,
  }), signal);
}

type IconName = "config" | "info" | "wardrobe" | "chevron" | "mic" | "micOff" | "video" | "clip" | "message" | "send" | "close" | "memory" | "sound" | "language" | "status" | "scene" | "plus" | "search" | "sun" | "moon";

function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  const iconUrl = `/icons/${name}.svg`;
  return <span className="app-icon" style={{ width: size, height: size, maskImage: `url("${iconUrl}")`, WebkitMaskImage: `url("${iconUrl}")` }} aria-hidden="true" />;
}

type Message = HistoryMessage;
type OrbDirection = "mic" | "camera" | "type" | "settings";
type Memory = { id: number; memory: string; category: string; importance: number };
type Panel = "conversations" | "memories" | "character" | "scenes" | "voice" | "status" | "settings";
type Conversation = HistoryConversation;
function isModelVisible(pack: ModelPackage, accountId: string): boolean {
  return !pack.cloudOwner || pack.cloudOwner === accountId || pack.cloudOwner === "shared";
}
const CONVERSATIONS_KEY = HISTORY_CACHE_KEY;
function modelExpressionPreferenceKey(packageId: string, manifestPath: string): string {
  return `vivian-model-expressions:${packageId}:${manifestPath}`;
}
const LANGUAGE_OPTIONS: Array<{ code: SpeechLanguage; label: string; nativeName: string }> = [
  { code: "global", label: "ทุกภาษา", nativeName: "Global" },
  { code: "th", label: "Thai", nativeName: "TH" },
  { code: "en", label: "English", nativeName: "EN" },
  { code: "ja", label: "Japanese", nativeName: "JP" },
  { code: "ko", label: "Korean", nativeName: "KR" },
  { code: "zh", label: "Chinese", nativeName: "CN" },
];
// Quick actions shown as a frosted glass row above the orb on double-tap.
const ORB_DIRECTIONS: Array<{ key: OrbDirection; icon: IconName; label: string }> = [
  { key: "mic", icon: "mic", label: "mic" },
  { key: "camera", icon: "video", label: "cam" },
  { key: "type", icon: "message", label: "chat" },
  { key: "settings", icon: "config", label: "setting" },
];
const greetings: Record<SpeechLanguage, string[]> = {
  global: [
    "[softly] มาแล้ว. วันนี้ไปไหนมา เล่าให้ฉันฟังหน่อย",
    "[playful] กลับมาหาฉันแล้วสินะ. คราวนี้ห้ามหายไปนานแบบนั้นอีก",
  ],
  th: [
    "[softly] มาแล้ว. วันนี้ไปไหนมา เล่าให้ฉันฟังหน่อย",
    "[curious] อ้อ มาแล้วเหรอ. มีอะไรเกิดขึ้นบ้าง ฉันอยากรู้",
    "[playful] กลับมาหาฉันแล้วสินะ. คราวนี้ห้ามหายไปนานแบบนั้นอีก",
  ],
  en: [
    "[softly] You're here. Where were you today? Tell me.",
    "[playful] Back with me. Don't disappear for that long again.",
  ],
  ja: [
    "[softly] 来たんだ。今日はどこに行ってたの。話して。",
    "[playful] 戻ってきたね。あんなに長くいなくならないで。",
  ],
  ko: [
    "[softly] 왔구나. 오늘은 어디 갔다 온 거야. 말해 줘.",
    "[playful] 돌아왔네. 그렇게 오래 사라지지 마.",
  ],
  zh: [
    "[softly] 你来了。今天去了哪里，跟我说。",
    "[playful] 回来了。下次别消失那么久。",
  ],
};
const greeting = (language: SpeechLanguage = "th"): Message => {
  const lines = greetings[language] ?? greetings.th;
  return historyMessage("vivian", lines[Math.floor(Math.random() * lines.length)]);
};
const GREETING_PENDING = "Vivian กำลังนึกว่าจะพูดอะไร...";
const BACKGROUNDS = { day: "/backgrounds/christmas-day-4x3.jpg", night: "/backgrounds/christmas-night-4x3.jpg" } as const;
const PRESET_SCENE_IMAGES = Object.values(BACKGROUNDS);
const APP_CODENAME = "None";
const SILENT_WAV = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
const CHAT_TIMEOUT_MS = 35000;
// The server aborts Fish at 14 seconds. Give the response a small transport
// margin, then always release the sending state instead of leaving "Thinking".
const TTS_TIMEOUT_MS = 17000;
const STT_TIMEOUT_MS = 28000;
const AUDIO_UNLOCK_MS = 1200;
const PLAYBACK_START_MS = 2500;
const AUDIO_SYNC_SETTLE_MS = 140;
const MIN_RECORDING_MS = 550;
const MIN_SPEECH_MS = 320;
const IDLE_AFTER_MS = 75_000;
const IDLE_COOLDOWN_MS = 8 * 60 * 1000;
const LAST_IDLE_KEY = "vivian-last-idle";
const VISION_MIN_INTERVAL_MS = 5000;
const VISION_MAX_INTERVAL_MS = 10000;
const VISION_COOLDOWN_MS = 6000;

function abortAfter(ms: number) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  window.setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T) {
  let timer: number | undefined;
  return Promise.race([
    promise,
    new Promise<T>((resolve) => { timer = window.setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => { if (timer) window.clearTimeout(timer); });
}

export default function Companion({ accountEmail, accountId }: { accountEmail: string; accountId: string }) {
  // Sign-in gate (Cloudflare flow): the bearer token lives in localStorage
  // (vivian_auth_token). Consume `#token=...` first, then enforce login.
  useEffect(() => {
    try {
      const match = window.location.hash.match(/#token=([^&]+)/);
      if (match?.[1]) {
        window.localStorage.setItem("vivian_auth_token", decodeURIComponent(match[1]));
        window.history.replaceState(null, "", window.location.pathname);
        return;
      }
      if (!window.localStorage.getItem("vivian_auth_token")) {
        window.location.replace("/login");
      }
    } catch {
      // Storage unavailable — let the API 401s drive the flow
    }
  }, []);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pixiAppRef = useRef<any>(null);
  const modelRef = useRef<any>(null);
  const modelPresentationRef = useRef<{ model: NonNullable<typeof modelRef.current>; dispose: () => void } | null>(null);
  const modelRenderAbortRef = useRef<AbortController | null>(null);
  const [backgroundReady, setBackgroundReady] = useState(false);
  const modelSelectionAbortRef = useRef<AbortController | null>(null);
  const modelSelectionTimingRef = useRef<LocalTiming | undefined>(undefined);
  const startupTimingRef = useRef<LocalTiming | undefined>(undefined);
  const modelRestStateRef = useRef<ModelRestState | null>(null);
  const modelLoadIdRef = useRef(0);
  const modelTransformRef = useRef<ModelTransform>({ x: 0, y: 0, scale: 1 });
  const modelBaseScaleRef = useRef(1);
  const startupModelResolvedRef = useRef(false);
  const expressionActionRef = useRef(0);
  const motionActionRef = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingStartedAtRef = useRef(0);
  const voiceContextRef = useRef<AudioContext | null>(null);
  const voiceActivityRef = useRef<VoiceActivityState | null>(null);
  const voiceAnalyserRef = useRef<AnalyserNode | null>(null);
  const voiceSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const voiceMonitorRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioUnlockPromiseRef = useRef<Promise<void> | null>(null);
  const audioPrimedRef = useRef(false);
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const lipSyncFrameRef = useRef<number | null>(null);
  const speakIdRef = useRef(0);
  const greetingSpokenRef = useRef(false);
  const greetingRequestRef = useRef<AbortController | null>(null);
  const greetingGenerationRef = useRef(0);
  const greetingTextRef = useRef<string | null>(null);
  const greetingLanguageRef = useRef<SpeechLanguage | null>(null);
  const audioUnlockedByUserRef = useRef(false);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);
  const resettingRef = useRef(false);
  const memoryGenerationRef = useRef(0);
  const speakingRef = useRef(false);
  const mutedRef = useRef(false);
  const recordingRef = useRef(false);
  const micEnabledRef = useRef(false);
  const interactedRef = useRef(false);
  const lastActivityRef = useRef(Date.now());
  const idleBusyRef = useRef(false);
  const voiceIdRef = useRef("");
  const speechLanguageRef = useRef<SpeechLanguage>("th");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraActiveRef = useRef(false);
  const lastVisionTriggerRef = useRef(0);
  const visionTimerRef = useRef<number | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<"user" | "environment">("user");
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  cameraActiveRef.current = cameraActive;
  // Keep the first server/client render identical while the greeting loads.
  const initialGreeting = useRef<Message>({ from: "vivian", text: GREETING_PENDING });
  const messagesRef = useRef<Message[]>([initialGreeting.current]);
  const companionRef = useRef<CompanionState>(defaultCompanionState());
  const [message, setMessage] = useState("");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [recording, setRecording] = useState(false);
  const [muted, setMuted] = useState(false);
  const [sending, setSending] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const [radialOpen, setRadialOpen] = useState(false);
  const radialOpenRef = useRef(false);
  const orbPointerRef = useRef<{ x: number; y: number } | null>(null);
  // Push-to-talk: hold ≈220ms starts recording; release stops and transcribes.
  const orbHoldTimerRef = useRef<number | null>(null);
  const orbPttActiveRef = useRef(false);
  const orbLastTapRef = useRef(0);
  // Live mic loudness lives in a MotionValue so 60fps updates never re-render.
  const micAmplitude = useMotionValue(0);
  const [sttPreview, setSttPreview] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const panelRef = useRef<Panel | null>(null);
  const sidebarOpenRef = useRef(false);
  const [greetingTrigger, setGreetingTrigger] = useState(0);
  const activeConversationRef = useRef("daily-talk");
  const [conversationSearch, setConversationSearch] = useState("");
  const [characterTab, setCharacterTab] = useState<"outfit" | "expression" | "pose">("outfit");
  const [languageOpen, setLanguageOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const selectedModel: ModelKey = "Miss";
  const [modelPackages, setModelPackages] = useState<ModelPackage[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const activeModelIdRef = useRef<string | null>(null);
  activeModelIdRef.current = activeModelId;
  const [modelsReady, setModelsReady] = useState(false);
  const [modelSelectionResolved, setModelSelectionResolved] = useState(false);
  const [modelImporting, setModelImporting] = useState(false);
  const [modelImportProgress, setModelImportProgress] = useState<{ label: string; percent: number | null } | null>(null);
  const [modelUploadKey, setModelUploadKey] = useState(0);
  const [modelStatus, setModelStatus] = useState<"empty" | "loading" | "ready" | "error">("empty");
  const [startupModelPending, setStartupModelPending] = useState(false);
  const [modelSwitchPending, setModelSwitchPending] = useState(false);
  const [modelNotice, setModelNotice] = useState<string | null>(null);
  const modelCloudRequestRef = useRef<Promise<CloudLibrary | null> | null>(null);
  const [cloudLibrary, setCloudLibrary] = useState<CloudLibrary | null>(null);
  const modelPreloadAbortRef = useRef<AbortController | null>(null);
  const cloudLibraryRef = useRef<CloudLibrary | null>(null);
  cloudLibraryRef.current = cloudLibrary;
  const [modelPreviews, setModelPreviews] = useState<Record<string, string>>({});
  const [pendingModelId, setPendingModelId] = useState<string | null>(null);
  const snapshotMapRef = useRef<Promise<Map<string, Blob>> | null>(null);
  const modelPreviewUrlsRef = useRef(new Map<string, { path: string; url: string }>());
  const [textureQuality, setTextureQuality] = useState<"auto" | "original">("auto");
  const [modelReload, setModelReload] = useState(0);
  const [graphicsLost, setGraphicsLost] = useState(false);
  const [modelPaused, setModelPaused] = useState(false);
  const [textureSummary, setTextureSummary] = useState<string | null>(null);
  const [activeExpression, setActiveExpression] = useState<string | null>(null);
  const [activeExpressions, setActiveExpressions] = useState<string[]>([]);
  const [activeExpressionsModelId, setActiveExpressionsModelId] = useState<string | null>(null);
  const activeExpressionsRef = useRef<string[]>([]);
  const activeExpressionModelRef = useRef<string | null>(null);
  const pendingExpressionPreferencesRef = useRef(new Map<string, string[]>());
  const expressionSaveQueuesRef = useRef(new Map<string, Promise<void>>());
  const expressionSaveVersionsRef = useRef(new Map<string, number>());
  const aiExpressionStacksRef = useRef(new Map<string, Map<string, string>>());
  const [activeMotion, setActiveMotion] = useState<string | null>(null);
  const modelFolderRef = useRef<HTMLInputElement>(null);
  const activePackage = modelPackages.find((pack) => pack.models.some((model) => model.id === activeModelId));
  const activeModel = activePackage?.models.find((model) => model.id === activeModelId);
  const modelCarouselEntries = useMemo(
    () => modelPackages.flatMap((pack) => pack.models.map((model) => ({ pack, model }))),
    [modelPackages],
  );
  const modelCarouselIndex = Math.max(0, modelCarouselEntries.findIndex(({ model }) => model.id === (pendingModelId ?? activeModelId)));
  const live2dBusy = startupModelPending || modelSwitchPending || modelStatus === "loading";
  const modelCarouselItems: CoverflowCarouselItem[] = useMemo(() => modelCarouselEntries.map(({ pack, model }) => {
    const isFocused = model.id === (pendingModelId ?? activeModelId);
    let badge: CoverflowCarouselItem["badge"];
    if (isFocused && live2dBusy) {
      badge = <span className="model-load-badge is-loading" role="status"><span className="load-dot is-loading" aria-hidden="true" />Loading…</span>;
    } else if (isFocused && modelStatus === "ready") {
      badge = <span className="model-load-badge is-ready" role="status"><span className="load-dot is-ready" aria-hidden="true" />Loaded</span>;
    } else if (isFocused && modelStatus === "error") {
      badge = <span className="model-load-badge is-error" role="status"><span className="load-dot is-error" aria-hidden="true" />Not loaded</span>;
    }
    return {
      id: model.id,
      image: modelPreviews[model.id],
      alt: `${model.name} profile`,
      badge,
      content: <span className="grid gap-1"><strong className="text-base">{model.name}</strong><small className="text-white/85">{cloudLibrary?.models.some((entry) => entry.id === pack.id) ? "Cloud model" : "This device"}</small></span>,
    };
  }), [cloudLibrary, live2dBusy, modelCarouselEntries, modelPreviews, modelStatus, pendingModelId, activeModelId]);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [companion, setCompanion] = useState<CompanionState>(defaultCompanionState());
  const {
    customInstructions,
    savedCustomInstructions,
    updateCustomInstructions,
    saveCustomInstructions,
    resetCustomInstructions,
    savingCustomInstructions,
    customInstructionsDirty,
    customInstructionsSynced,
    customInstructionsNotice,
  } = useCustomInstructions();
  const customInstructionsRef = useRef("");
  useEffect(() => { customInstructionsRef.current = savedCustomInstructions; }, [savedCustomInstructions]);
  const [editingMemoryId, setEditingMemoryId] = useState<number | null>(null);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [backgroundMode, setBackgroundMode] = useState<keyof typeof BACKGROUNDS>("day");
  const sceneLibrary = useSceneLibrary(PRESET_SCENE_IMAGES, accountId, backgroundReady);
  const activeCustomSceneId = sceneLibrary.preferences.activeSceneId;
  const selectedPreset = sceneLibrary.preferences.preset ?? backgroundMode;
  const { voiceId, language: speechLanguage, saveVoiceId, saveLanguage, notice: voiceNotice, refresh: refreshVoicePreferences } = useVoicePreferences();
  const [voiceIdInput, setVoiceIdInput] = useState("");
  useEffect(() => { setVoiceIdInput(voiceId); }, [voiceId]);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const history = useConversationHistory(initialGreeting.current, GREETING_PENDING, sending || resetting);
  const { messages, setMessages, conversations, activeConversationId, setActiveConversationId } = history;
  const [resetConfirming, setResetConfirming] = useState(false);
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  const [streak, setStreak] = useState(0);
  const lastVivianMessage = messages.filter((item) => item.from === "vivian").at(-1)?.text ?? initialGreeting.current.text;
  messagesRef.current = messages;
  activeConversationRef.current = activeConversationId;
  sendingRef.current = sending;
  mutedRef.current = muted;
  voiceIdRef.current = voiceId;
  speechLanguageRef.current = speechLanguage;
  companionRef.current = companion;

  useEffect(() => {
    const hour = new Date().getHours();
    setBackgroundMode(hour >= 6 && hour < 18 ? "day" : "night");
  }, []);

  function selectPresetScene(scene: keyof typeof BACKGROUNDS) {
    void sceneLibrary.updatePreferences({ preset: scene });
  }


  useEffect(() => {
    if (!sidebarOpen || panel !== "conversations") return;
    const refresh = window.setInterval(() => { void loadMemory(); }, 3000);
    return () => window.clearInterval(refresh);
  }, [sidebarOpen, panel]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    // Start the PIXI/Live2D module download now so it overlaps catalog and
    // cloud loading instead of serializing after the first model is chosen.
    void preloadLive2DModules().catch(() => {});
    const localRequest = loadModelCatalog().catch(() => [] as ModelPackage[]);
    let cancelCloudStart: (() => void) | undefined;
    let cancelPreload: (() => void) | undefined;
    const cloudRequest = localRequest.then((local) => new Promise<CloudLibrary | null>((resolve) => {
      const start = () => {
        if (controller.signal.aborted) { resolve(null); return; }
        void getCloudModels(AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)])).then(resolve, () => resolve(null));
      };
      if (local.some((pack) => isModelVisible(pack, accountId))) cancelCloudStart = scheduleBackgroundWork(start);
      else start(); // A cloud-only active model remains critical work.
      controller.signal.addEventListener("abort", () => resolve(null), { once: true });
    }));
    modelCloudRequestRef.current = cloudRequest;
    void (async () => {
      const local = await localRequest;
      if (cancelled) return;
      const packages = local.filter((pack) => isModelVisible(pack, accountId));
      const saved = localStorage.getItem("vivian-local-model");
      const selection = readModelSelection(localStorage);
      let selected = resolveStartupModel(packages, saved, selection);
      const restoreStartup = (selected: string | null): boolean => {
        let paused = false;
        try {
          if (shouldPauseModelStartup(sessionStorage, selected)) {
            paused = true;
            setModelPaused(true);
            setModelStatus("error");
            setModelNotice("Model loading was interrupted twice. Use Reload model to retry with Auto quality.");
          }
        } catch { /* Storage restrictions do not block chat. */ }
        return paused;
      };
      const startupPaused = restoreStartup(selected);
      if (startupPaused) { startupModelResolvedRef.current = true; setStartupModelPending(false); }
      setModelPackages(packages);
      refreshSnapshots(packages);
      setActiveModelId(selected);
      if (selected && !startupModelResolvedRef.current) setStartupModelPending(true);
      setModelSelectionResolved(false);
      // Render cached originals immediately; cloud latency is independent.
      if (selected) setModelsReady(true);
      const cloud = await cloudRequest;
      if (cancelled) return;
      setCloudLibrary(cloud);
      if (!cloud) {
        setModelNotice((notice) => notice ?? "Cloud sync is unavailable. Models saved on this device still work.");
        return;
      }
      setModelPackages((current) => {
        // Retain hydrated object identities so catalog sync doesn't reload GPU assets.
        const sharedIds = new Set(cloud.models.filter((model) => model.scope === "shared").map((model) => model.id));
        const merged = current.filter((pack) => !pack.cloudOwner || cloud.models.some((model) => model.id === pack.id))
          .map((pack) => sharedIds.has(pack.id) && pack.cloudOwner !== "shared" ? { ...pack, cloudOwner: "shared" } : pack);
        for (const pack of local.filter((entry) => sharedIds.has(entry.id))) {
          if (!merged.some((entry) => entry.id === pack.id)) merged.push({ ...pack, cloudOwner: "shared" });
        }
        for (const model of cloud.models) if (!merged.some((pack) => pack.id === model.id)) merged.push(cloudModelPlaceholder(model));
        return merged;
      });
      const sharedCaches = local.filter((pack) => cloud.models.some((model) => model.scope === "shared" && model.id === pack.id)).map((pack) => ({ ...pack, cloudOwner: "shared" }));
      const reconciledPackages = packages.filter((pack) => pack.cloudOwner !== "shared" || cloud.models.some((model) => model.scope === "shared" && model.id === pack.id));
      const allPackages = [...reconciledPackages, ...sharedCaches.filter((pack) => !reconciledPackages.some((localPack) => localPack.id === pack.id)), ...cloud.models.map(cloudModelPlaceholder).filter((pack) => !local.some((localPack) => localPack.id === pack.id))];
      const globalSelection = cloud.preference?.modelId;
      selected = globalSelection && allPackages.some((pack) => pack.models.some((model) => model.id === globalSelection))
        ? globalSelection : resolveStartupModel(allPackages, saved, selection);
      const cloudStartupPaused = restoreStartup(selected);
      if (cloudStartupPaused) { startupModelResolvedRef.current = true; setStartupModelPending(false); }
      setActiveModelId(selected);
      if (selected && !startupModelResolvedRef.current) setStartupModelPending(true);
      setModelSelectionResolved(true);
      refreshSnapshots(allPackages);
      if (cloud.models.length) {
        const preloadController = new AbortController();
        modelPreloadAbortRef.current?.abort();
        modelPreloadAbortRef.current = preloadController;
        cancelPreload = scheduleBackgroundWork(() => {
          void preloadModelPackages(allPackages.filter((pack) => cloud.models.some((model) => model.id === pack.id)), globalSelection ?? selected,
            (pack, signal) => preloadPackage(pack, cloud, signal), preloadController.signal);
        }, 1500);
      }
    })().catch(() => {
      if (!cancelled) setModelNotice("Model storage is unavailable. Please try again.");
    }).finally(() => { if (!cancelled) { setModelSelectionResolved(true); setModelsReady(true); } });
    return () => { cancelled = true; cancelCloudStart?.(); cancelPreload?.(); modelPreloadAbortRef.current?.abort(); controller.abort(); };
  }, [accountId]);

  useEffect(() => {
    if (!modelsReady || !modelSelectionResolved) return;
    if (activeModelId) writeModelSelection(localStorage, activeModelId);
    else localStorage.removeItem("vivian-local-model");
  }, [modelsReady, modelSelectionResolved, activeModelId]);

  useEffect(() => {
    if (pendingModelId && pendingModelId === activeModelId) setPendingModelId(null);
  }, [activeModelId, pendingModelId]);

  useEffect(() => {
    let disposed = false;
    let refreshTimer: number | undefined;
    const unsubscribe = subscribeModelLibrary(() => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void (async () => {
          const cloud = await getCloudModels(AbortSignal.timeout(12_000)).catch(() => null);
          if (!cloud || disposed) return;
          setCloudLibrary(cloud);
          setModelPackages((current) => {
            const sharedIds = new Set(cloud.models.filter((model) => model.scope === "shared").map((model) => model.id));
            const merged = current.filter((pack) => !pack.cloudOwner || pack.models.some((model) => model.id === activeModelIdRef.current) || cloud.models.some((model) => model.id === pack.id))
              .map((pack) => sharedIds.has(pack.id) && pack.cloudOwner !== "shared" && !pack.models.some((model) => model.id === activeModelIdRef.current) ? { ...pack, cloudOwner: "shared" } : pack);
            for (const model of cloud.models) if (!merged.some((pack) => pack.id === model.id)) merged.push(cloudModelPlaceholder(model));
            return merged;
          });
          modelPreloadAbortRef.current?.abort();
          const preloadController = new AbortController();
          modelPreloadAbortRef.current = preloadController;
          refreshSnapshots(cloud.models.map(cloudModelPlaceholder));
          void preloadModelPackages(cloud.models.map(cloudModelPlaceholder), cloud.preference?.modelId ?? null,
            (pack, signal) => preloadPackage(pack, cloud, signal), preloadController.signal);
          // Deliberately do not change activeModelId here; other tabs pick this on reload.
        })();
      }, 400);
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      modelPreloadAbortRef.current?.abort();
    };
  }, [accountId]);

  function cacheModelPreviews(pack: ModelPackage) {
    const updates: Record<string, string> = {};
    for (const model of pack.models) {
      if (!model.previewPath) continue;
      const current = modelPreviewUrlsRef.current.get(model.id);
      if (current?.path === model.previewPath) continue;
      const asset = pack.assets.find((entry) => entry.path === model.previewPath);
      if (!asset) continue;
      if (current) URL.revokeObjectURL(current.url);
      const url = URL.createObjectURL(asset.blob);
      modelPreviewUrlsRef.current.set(model.id, { path: model.previewPath, url });
      updates[model.id] = url;
    }
    if (Object.keys(updates).length) setModelPreviews((current) => ({ ...current, ...updates }));
  }

  function refreshSnapshots(packages: ModelPackage[]) {
    snapshotMapRef.current ??= loadModelPreviews();
    void snapshotMapRef.current
      .then((blobs) => {
        const known = new Set(packages.flatMap((pack) => pack.models.map((model) => model.id)));
        const updates: Record<string, string> = {};
        for (const [modelId, blob] of blobs) {
          if (!known.has(modelId) || !blob?.size) continue;
          if (modelPreviewUrlsRef.current.has(modelId)) continue;
          const url = URL.createObjectURL(blob);
          modelPreviewUrlsRef.current.set(modelId, { path: SNAPSHOT_PREVIEW_PATH, url });
          updates[modelId] = url;
        }
        if (Object.keys(updates).length) setModelPreviews((current) => ({ ...current, ...updates }));
      })
      .catch(() => {});
  }

  function cacheSnapshotPreview(modelId: string, blob: Blob) {
    const current = modelPreviewUrlsRef.current.get(modelId);
    if (current && current.path !== SNAPSHOT_PREVIEW_PATH) return;
    if (current) URL.revokeObjectURL(current.url);
    const url = URL.createObjectURL(blob);
    modelPreviewUrlsRef.current.set(modelId, { path: SNAPSHOT_PREVIEW_PATH, url });
    setModelPreviews((prev) => ({ ...prev, [modelId]: url }));
    void snapshotMapRef.current?.then((map) => { map.set(modelId, blob); }).catch(() => {});
    void saveModelPreview(modelId, blob);
  }

  function releaseModelPreviews(packageId: string) {
    const removedIds: string[] = [];
    for (const [modelId, preview] of modelPreviewUrlsRef.current) {
      if (!modelId.startsWith(`${packageId}:`)) continue;
      URL.revokeObjectURL(preview.url);
      modelPreviewUrlsRef.current.delete(modelId);
      removedIds.push(modelId);
    }
    if (removedIds.length) setModelPreviews((current) => {
      const next = { ...current };
      for (const modelId of removedIds) delete next[modelId];
      return next;
    });
  }

  useEffect(() => () => {
    for (const preview of modelPreviewUrlsRef.current.values()) URL.revokeObjectURL(preview.url);
    modelPreviewUrlsRef.current.clear();
  }, []);

  function applyModelTransform() {
    const model = modelRef.current;
    const canvas = canvasRef.current;
    if (!model || !canvas) return;
    const stage = canvas.parentElement?.getBoundingClientRect();
    if (!stage || !stage.width || !stage.height) return;
    modelTransformRef.current = clampModelTransform(modelTransformRef.current, stage.width, stage.height);
    const base = modelBaseScaleRef.current || 1;
    model.scale.set(base * modelTransformRef.current.scale);
    model.x = stage.width / 2 + modelTransformRef.current.x;
    model.y = stage.height * 0.99 + modelTransformRef.current.y;
  }

  function persistModelTransform() {
    const activeId = activeModelIdRef.current;
    if (!activeId) return;
    saveModelTransform(activeId, { ...modelTransformRef.current });
  }

  function resetModelTransform() {
    modelTransformRef.current = { x: 0, y: 0, scale: 1 };
    applyModelTransform();
    persistModelTransform();
  }

  function preloadPackage(pack: ModelPackage, cloud: CloudLibrary | Promise<CloudLibrary | null> | null, signal: AbortSignal) {
    return availableModelPackage(pack, cloud, signal).then((loaded) => {
      signal.throwIfAborted();
      if (loaded) cacheModelPreviews(loaded);
      return loaded;
    });
  }

  async function importModels(files: File[]) {
    if (modelImporting || !files.length) return;
    startupModelResolvedRef.current = true;
    setStartupModelPending(false);
    setModelImporting(true);
    setModelImportProgress({ label: "Preparing model import…", percent: null });
    const wasPaused = modelPaused;
    setModelPaused(true);
    setModelNotice(null);
    try {
      // Let the render effect release the old model and GPU textures before
      // expanding another package. Keep rendering paused through cloud sync.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const importingZip = files.length === 1 && /\.zip$/i.test(files[0].name);
      setModelImportProgress(importingZip ? { label: "Extracting model files…", percent: 0 } : { label: "Inspecting model files…", percent: null });
      let reportedExtraction = -1;
      const pack = await importModelFiles(files, importingZip ? (ratio) => {
        const percent = Math.min(99, Math.round(Math.max(0, Math.min(1, ratio)) * 100));
        if (percent <= reportedExtraction) return;
        reportedExtraction = percent;
        setModelImportProgress({ label: "Extracting model files…", percent });
      } : undefined);
      setModelImportProgress({ label: "Caching model on this device…", percent: null });
      await saveModelPackage(pack);
      setModelPackages((current) => [...current.map(modelCatalogEntry), pack]);
      setActiveModelId(pack.models[0].id);
      void navigator.storage?.persist?.().catch(() => {});
      if (cloudLibrary) {
        setModelImportProgress({ label: "Preparing private cloud copy…", percent: null });
        await syncModelToCloud(pack, importingZip ? files[0] : undefined);
      }
    } catch (error) {
      setModelNotice(error instanceof Error ? error.message : "Could not import this model.");
    } finally {
      setModelImporting(false);
      setModelImportProgress(null);
      setModelPaused(wasPaused);
    }
  }

  async function syncModelToCloud(pack: ModelPackage, originalZip?: File) {
    const saved = await uploadCloudModel(pack, (message) => {
      const match = /(\d{1,3})%/.exec(message);
      setModelImportProgress({ label: message.replace(/\s*\d{1,3}%\s*$/, "").trim(), percent: match ? Math.min(100, Number(match[1])) : null });
    }, originalZip);
    // Commit the new cache before discarding the existing local-only package.
    await saveModelPackage(saved.pack).catch(() => {});
    setModelPackages((current) => current.map((entry) => entry.id === pack.id ? saved.pack : entry));
    const selectedId = saved.pack.models.find((model) => model.manifestPath === activeModel?.manifestPath)?.id ?? saved.pack.models[0].id;
    setActiveModelId(selectedId);
    void saveCloudModelPreference(selectedId).catch(() => {});
    setCloudLibrary((current) => current ? { ...current, usage: saved.usage, models: [...current.models, { id: saved.pack.id, byteSize: 0, manifests: saved.pack.models.map((model) => ({ path: model.manifestPath, name: model.name })) }] } : current);
    await removeModelPackage(pack.id).catch(() => {});
    setModelNotice("Model saved privately to cloud.");
  }

  async function saveActiveModelToCloud() {
    if (!activePackage || modelImporting || !cloudLibrary) return;
    setModelImporting(true);
    setModelImportProgress({ label: "Preparing private cloud copy…", percent: null });
    try { await syncModelToCloud(activePackage); }
    catch (error) { setModelNotice(error instanceof Error ? error.message : "Could not save model to cloud."); }
    finally { setModelImporting(false); setModelImportProgress(null); }
  }

  async function chooseModel(id: string) {
    if (modelImporting) return;
    startupModelResolvedRef.current = true;
    setStartupModelPending(false);
    const pack = modelPackages.find((entry) => entry.models.some((model) => model.id === id));
    if (!pack) return;
    setModelSwitchPending(true);
    modelSelectionAbortRef.current?.abort();
    const abort = new AbortController(); modelSelectionAbortRef.current = abort;
    cancelTiming(modelSelectionTimingRef.current);
    modelSelectionTimingRef.current = startTiming("model_select_to_first_frame");
    // Cancel pending render preparation immediately, while retaining its predecessor.
    modelLoadIdRef.current++;
    modelRenderAbortRef.current?.abort();
    setModelNotice("Loading model files…");
    try {
      const downloaded = await availableModelPackage(pack, cloudLibrary ?? modelCloudRequestRef.current, abort.signal);
      abort.signal.throwIfAborted();
      if (!downloaded) throw new Error("Model files are unavailable.");
      if (!downloaded.models.some((model) => model.id === id)) throw new Error("This model is no longer in the package. Select another model.");
      cacheModelPreviews(downloaded);
      setModelPackages((current) => current.map((entry) => entry.id === pack.id ? downloaded : modelCatalogEntry(entry)));
      setActiveModelId(id);
      writeModelSelection(localStorage, id);
      if (cloudLibrary?.models.some((model) => model.id === pack.id)) void saveCloudModelPreference(id).catch(() => {});
      setModelNotice(null);
      setModelPaused(false);
      setModelReload((value) => value + 1);
    } catch (error) {
      if (abort.signal.aborted) return;
      setPendingModelId(null);
      setModelSwitchPending(false);
      cancelTiming(modelSelectionTimingRef.current);
      setModelStatus(modelRef.current ? "ready" : "error");
      setModelNotice(error instanceof Error ? error.message : "Could not load model.");
    } finally { if (modelSelectionAbortRef.current === abort) modelSelectionAbortRef.current = null; }
  }

  async function removeActiveModel() {
    if (!activePackage || modelImporting) return;
    setModelImporting(true);
    try {
      if (cloudLibrary?.models.some((model) => model.id === activePackage.id)) {
        await deleteCloudModel(activePackage.id);
        setCloudLibrary((current) => current ? { ...current, models: current.models.filter((model) => model.id !== activePackage.id) } : current);
        void getCloudModels().then(setCloudLibrary).catch(() => {});
      }
      await removeModelPackage(activePackage.id);
      releaseModelPreviews(activePackage.id);
      for (const model of activePackage.models) clearModelTransform(model.id);
      void Promise.all(activePackage.models.map((model) => removeModelPreview(model.id))).catch(() => {});
      const remaining = modelPackages.filter((pack) => pack.id !== activePackage.id);
      setModelPackages(remaining);
      setActiveModelId(remaining[0]?.models[0]?.id ?? null);
      setModelNotice(null);
    } catch { setModelNotice("Could not remove the saved model. Please try again."); }
    finally { setModelImporting(false); }
  }

  function toggleSavedExpression(expression: string) {
    if (!activeModel || !activePackage || !activeModel.expressions.includes(expression)) return;
    const current = activeExpressionModelRef.current === activeModel.id ? activeExpressionsRef.current : [];
    const next = current.includes(expression) ? current.filter((item) => item !== expression) : [...current, expression];
    if (next.length > 128) { setModelNotice("Choose up to 128 expressions for one model."); return; }
    saveExpressionSelection(next);
  }

  function saveExpressionSelection(next: string[]) {
    if (!activeModel || !activePackage) return;
    const key = modelExpressionPreferenceKey(activePackage.id, activeModel.manifestPath);
    activeExpressionModelRef.current = activeModel.id;
    activeExpressionsRef.current = next;
    setActiveExpressionsModelId(activeModel.id);
    pendingExpressionPreferencesRef.current.set(key, next);
    setActiveExpressions(next);
    setActiveExpression(null);
    setModelNotice(null);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Cloud preference remains available when configured. */ }
    setModelReload((value) => value + 1);

    if (!cloudLibraryRef.current?.models.some((model) => model.id === activePackage.id)) return;
    const saveVersion = (expressionSaveVersionsRef.current.get(key) ?? 0) + 1;
    expressionSaveVersionsRef.current.set(key, saveVersion);
    const previousSave = expressionSaveQueuesRef.current.get(key) ?? Promise.resolve();
    const request = previousSave.catch(() => {}).then(() => saveCloudModelExpressions(activePackage.id, activeModel.manifestPath, next));
    expressionSaveQueuesRef.current.set(key, request.then(() => {}, () => {}));
    void request.then((result) => {
      if (expressionSaveVersionsRef.current.get(key) !== saveVersion) return;
      pendingExpressionPreferencesRef.current.set(key, result.expressions);
      const currentLibrary = cloudLibraryRef.current;
      if (!currentLibrary) return;
      const updated: CloudLibrary = {
        ...currentLibrary,
        models: currentLibrary.models.map((model) => model.id === activePackage.id
          ? { ...model, expressionPreferences: { ...model.expressionPreferences, [activeModel.manifestPath]: result.expressions } }
          : model),
      };
      cloudLibraryRef.current = updated;
      setCloudLibrary(updated);
    }).catch(() => { if (expressionSaveVersionsRef.current.get(key) === saveVersion) setModelNotice("Saved on this device; cloud sync is unavailable."); });
  }

  function clearSavedExpressions() {
    const selected = activeExpressionModelRef.current === activeModel?.id ? activeExpressionsRef.current : [];
    if (!selected.length) { resetReaction(); return; }
    saveExpressionSelection([]);
  }

  async function selectMotion(motion: ModelMotion | null) {
    const actionId = ++motionActionRef.current;
    const loadId = modelLoadIdRef.current;
    try {
      const manager = modelRef.current?.internalModel?.motionManager;
      if (!manager) return;
      manager.stopAllMotions();
      setModelNotice(null);
      setActiveMotion(motion ? `${motion.group}:${motion.index}` : null);
      if (!motion && modelRestStateRef.current) {
        restoreModelRestState(modelRef.current.internalModel.coreModel, modelRestStateRef.current);
      }
      if (motion) {
        const started = await modelRef.current.motion(motion.group, motion.index, 3);
        if (actionId !== motionActionRef.current || loadId !== modelLoadIdRef.current) return;
        if (!started) throw new Error("Motion unavailable");
      }
    } catch {
      if (actionId === motionActionRef.current && loadId === modelLoadIdRef.current) {
        setActiveMotion(null);
        setModelNotice("This motion could not be played.");
      }
    }
  }

  useEffect(() => {
    if (!preferencesReady || !history.ready) return;
    if (messagesRef.current.length !== 1 || messagesRef.current[0].text !== GREETING_PENDING) return;
    const previousSession = conversations
      .filter((item) => item.id !== activeConversationId && item.messages.some((entry) => entry.from === "me"))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const previousMessages = previousSession?.messages
      .filter((item) => item.text !== GREETING_PENDING && item.text !== "[ส่งรูปภาพ]")
      .slice(-6)
      .map((item) => ({ role: item.from === "me" ? "user" : "assistant", content: item.text.slice(0, 500) })) ?? [];
    const conversationId = activeConversationId;
    const requestId = ++greetingGenerationRef.current;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, CHAT_TIMEOUT_MS);
    greetingRequestRef.current = controller;
    greetingTextRef.current = null;
    greetingSpokenRef.current = false;
    greetingLanguageRef.current = speechLanguageRef.current;
    void (async () => {
      try {
        const response = await authFetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ mode: "greeting", messages: previousMessages, character: selectedModel, customInstructions: customInstructionsRef.current, language: speechLanguageRef.current }),
        });
        if (!response.ok) throw new Error("Greeting unavailable");
        const data = await response.json() as { text?: string };
        const text = data.text?.trim();
        if (!text) throw new Error("Empty greeting");
        if (requestId !== greetingGenerationRef.current || activeConversationRef.current !== conversationId || messagesRef.current[0]?.text !== GREETING_PENDING) return;
        greetingTextRef.current = text;
        setMessages((current) => current.length === 1 && current[0].from === "vivian" ? [historyMessage("vivian", text)] : [...current, historyMessage("vivian", text)]);
        if (audioUnlockedByUserRef.current && !mutedRef.current && !greetingSpokenRef.current) {
          greetingSpokenRef.current = true;
          void speak(text);
        }
      } catch {
        if ((timedOut || !controller.signal.aborted) && requestId === greetingGenerationRef.current && activeConversationRef.current === conversationId && messagesRef.current[0]?.text === GREETING_PENDING) {
          const fallback = greeting(speechLanguageRef.current);
          setMessages((current) => current.length === 1 && current[0].text === GREETING_PENDING ? [fallback] : [...current, fallback]);
          if (audioUnlockedByUserRef.current && !mutedRef.current && !greetingSpokenRef.current) {
            greetingSpokenRef.current = true;
            void speak(fallback.text);
          }
        }
      } finally {
        window.clearTimeout(timeout);
        if (greetingRequestRef.current === controller) greetingRequestRef.current = null;
      }
    })();
    return () => controller.abort();
  }, [preferencesReady, greetingTrigger, history.ready, setMessages]);

  // A language change before the first user message regenerates the opening
  // line, so the badge, the spoken greeting and the reply agree.
  useEffect(() => {
    if (!preferencesReady || !history.ready) return;
    const usedLanguage = greetingLanguageRef.current;
    if (!usedLanguage || usedLanguage === speechLanguage) return;
    if (messagesRef.current.some((item) => item.from === "me")) return;
    greetingGenerationRef.current += 1;
    greetingRequestRef.current?.abort();
    greetingRequestRef.current = null;
    stopSpeech();
    greetingTextRef.current = null;
    greetingSpokenRef.current = false;
    setMessages([{ ...initialGreeting.current }]);
    setGreetingTrigger((value) => value + 1);
  }, [speechLanguage, preferencesReady, history.ready, setMessages]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { setPanel(null); setSidebarOpen(false); } };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sidebarOpen]);

  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    const lastCheckIn = window.localStorage.getItem("vivian-checkin-date");
    const previousStreak = Number(window.localStorage.getItem("vivian-streak") ?? 0);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const nextStreak = lastCheckIn === today ? previousStreak : lastCheckIn === yesterday ? previousStreak + 1 : 1;
    if (lastCheckIn !== today) window.localStorage.setItem("vivian-checkin-date", today);
    window.localStorage.setItem("vivian-streak", String(nextStreak));
    setStreak(nextStreak);
    setPreferencesReady(true);
  }, []);

  useEffect(() => {
    startupTimingRef.current = startTiming("page_load_to_model_first_frame", 0);
    return scheduleBackgroundWork(() => setBackgroundReady(true));
  }, []);

  useEffect(() => {
    const unlock = () => {
      audioUnlockedByUserRef.current = true;
      void unlockAudio();
      if (greetingTextRef.current && !greetingSpokenRef.current && !mutedRef.current) {
        greetingSpokenRef.current = true;
        void speak(greetingTextRef.current);
      }
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    const cancelMemory = scheduleBackgroundWork(() => { void loadMemory(); });
    const idleTimer = window.setInterval(() => { void maybeIdleGreeting(); }, 12000);
    const onVisible = () => { lastActivityRef.current = Date.now(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelMemory();
      window.removeEventListener("pointerdown", unlock);
      window.clearInterval(idleTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (!preferencesReady || !modelsReady || graphicsLost || modelPaused) return;
    setActiveExpression(null);
    setActiveMotion(null);
    if (!activeModel || !activePackage) {
      modelPresentationRef.current?.dispose(); modelPresentationRef.current = null;
      modelRef.current = null; modelRestStateRef.current = null;
      setModelStatus("empty"); setModelSwitchPending(false); return;
    }
    // Restore this model's saved drag position/zoom before the first frame.
    modelTransformRef.current = loadModelTransform(activeModel.id);
    modelBaseScaleRef.current = 1;
    setModelStatus("loading");
    setTextureSummary(null);
    const textureAbort = new AbortController();
    modelRenderAbortRef.current = textureAbort;
    let releaseResources: (() => void) | undefined;
    const compositeExpressionUrls = new Map<string, string>();
    let app: any;
    let resizeModel = () => {};
    let queueResize = () => {};
    let handleOrientationChange = () => {};
    let resizeFrame: number | undefined;
    let resizeTimeout: number | undefined;
    let disposed = false;
    let ownedModel: any;
    let promoted = false;
    let renderTiming: LocalTiming | undefined;
    const loadId = ++modelLoadIdRef.current;
    const clearBreadcrumb = () => {
      if (loadId !== modelLoadIdRef.current) return;
      try { clearModelLoadState(sessionStorage, activeModel.id); } catch { /* Optional crash recovery. */ }
    };
    const clearRecovery = () => {
      if (loadId !== modelLoadIdRef.current) return;
      try { clearModelLoadState(sessionStorage, activeModel.id, true); } catch { /* Optional crash recovery. */ }
    };
    // Normal refresh/navigation is not a WebContent crash.
    window.addEventListener("pagehide", clearRecovery);
    try { sessionStorage.setItem("vivian-model-loading", activeModel.id); } catch { /* Optional crash recovery. */ }
    void (async () => {
      try {
        // Start hydration now so IndexedDB/cloud work overlaps the module
        // download instead of waiting for PIXI to parse first.
        const hydrationPromise = availableModelPackage(activePackage, cloudLibraryRef.current ?? modelCloudRequestRef.current, textureAbort.signal);
        const [[PIXI, { Live2DModel, Cubism4ModelSettings }], , renderPackage] = await Promise.all([
          preloadLive2DModules(),
          waitForCubismCore(textureAbort.signal),
          hydrationPromise,
        ]);
        textureAbort.signal.throwIfAborted();
        if (!canvasRef.current || disposed) return;
        const isAppleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        // Keep the 4096 textures intact, but render the canvas above CSS
        // resolution on iPad/iPhone so the model is not visibly soft. The
        // 1.5 cap is a deliberate memory/performance guard for Safari.
        const appleResolution = Math.min(Math.max(window.devicePixelRatio || 1, 1), 1.5);
        (window as any).PIXI = PIXI;
        (Live2DModel as any).registerTicker(PIXI.Ticker);
        app = pixiAppRef.current;
        if (!app) {
          app = new PIXI.Application({
            view: canvasRef.current,
            backgroundAlpha: 0,
            antialias: !isAppleMobile,
            autoDensity: true,
            resolution: isAppleMobile ? appleResolution : Math.min(window.devicePixelRatio || 1, 2),
            powerPreference: isAppleMobile ? "low-power" : "high-performance",
          });
          app.ticker.maxFPS = isAppleMobile ? 30 : 60;
          pixiAppRef.current = app;
        }
        const maxTextureSize = app.renderer.gl.getParameter(app.renderer.gl.MAX_TEXTURE_SIZE) as number;
        canvasRef.current.dataset.gpuTextureLimit = String(maxTextureSize);
        const mobileDevice = isAppleMobile || /Android|Mobile/i.test(navigator.userAgent);
        // Catalog entries deliberately have no assets. Every path into this
        // effect (refresh, deletion, retry or selection) must hydrate first —
        // hydration already ran alongside the module download above.
        if (!renderPackage) throw new Error("Model files are unavailable on this device. Download the cloud copy or import the original model again.");
        cacheModelPreviews(renderPackage);
        if (renderPackage !== activePackage) {
          // Replace stale Blob handles in React too; otherwise every quality
          // change would try the broken in-memory copy and download again.
          setModelPackages((current) => current.map((entry) => entry.id === renderPackage.id ? renderPackage : entry));
          setModelNotice(null);
          return;
        }
        const renderModel = renderPackage.models.find((entry) => entry.id === activeModel.id || entry.manifestPath === activeModel.manifestPath);
        if (!renderModel) throw new Error("Model selection has changed. Please select the model again.");
        const preferenceKey = modelExpressionPreferenceKey(renderPackage.id, renderModel.manifestPath);
        const pendingExpressions = pendingExpressionPreferencesRef.current.get(preferenceKey);
        const cloudModel = cloudLibraryRef.current?.models.find((entry) => entry.id === renderPackage.id);
        const cloudHasPreference = Boolean(cloudModel?.expressionPreferences && Object.prototype.hasOwnProperty.call(cloudModel.expressionPreferences, renderModel.manifestPath));
        let savedExpressions = pendingExpressions ?? (cloudHasPreference ? cloudModel!.expressionPreferences![renderModel.manifestPath] : undefined);
        if (!savedExpressions) {
          try {
            const cached = JSON.parse(localStorage.getItem(preferenceKey) ?? "null");
            if (Array.isArray(cached) && cached.every((name) => typeof name === "string")) savedExpressions = cached;
          } catch { /* Optional local preference cache. */ }
        }
        const selectedExpressions = [...new Set((savedExpressions ?? []).filter((name) => renderModel.expressions.includes(name)))];
        activeExpressionsRef.current = selectedExpressions;
        activeExpressionModelRef.current = renderModel.id;
        setActiveExpressions(selectedExpressions);
        setActiveExpressionsModelId(renderModel.id);
        let shouldApplyStack = false;
        renderTiming = startTiming("model_load_to_first_frame");
        const resources = await createModelResources(renderPackage, renderModel, {
          // GPU limits alone do not account for framebuffers, decoded images,
          // Cubism masks and the rest of the page. Leave room for those too.
          maxDimension: textureQuality === "original" ? Math.min(maxTextureSize, mobileDevice ? 4096 : 8192) : Math.min(maxTextureSize, 4096),
          budgetBytes: (mobileDevice ? 64 : 128) * 1024 * 1024,
          original: textureQuality === "original",
          signal: textureAbort.signal,
        });
        releaseResources = () => {
          resources.dispose();
          for (const url of compositeExpressionUrls.values()) URL.revokeObjectURL(url);
          compositeExpressionUrls.clear();
        };
        if (disposed || loadId !== modelLoadIdRef.current) { releaseResources(); return; }
        let manifest = resources.manifest;
        let resolveModelAsset = resources.resolve;
        if (selectedExpressions.length) {
          const expressionDefinitions = resources.manifest.FileReferences.Expressions ?? [];
          const parameterSets = await loadExpressionParameterSets(expressionDefinitions, resources.resolve);
          const stackSelections = selectedExpressions.filter((name) => parameterSets.has(name));
          if (stackSelections.length !== selectedExpressions.length) setModelNotice("Some saved expressions are unavailable in this model copy.");
          const stack = createExpressionStack(parameterSets, stackSelections);
          if (stack) {
            shouldApplyStack = true;
            compositeExpressionUrls.set(SAVED_EXPRESSION_STACK_FILE, URL.createObjectURL(stack));
            const expressions = expressionDefinitions.filter((item) => item.Name !== SAVED_EXPRESSION_STACK_NAME);
            const emotionStackNames = new Map<string, string>();
            const emotionDefinitions: Array<{ Name: string; File: string }> = [];
            for (const [index, definition] of expressionDefinitions.entries()) {
              if (stackSelections.includes(definition.Name)) {
                emotionStackNames.set(definition.Name, SAVED_EXPRESSION_STACK_NAME);
                continue;
              }
              const combined = createExpressionStack(parameterSets, [...stackSelections, definition.Name]);
              if (!combined) continue;
              const name = `__VivianSavedEmotionStack${index}__`;
              const file = `__vivian_saved_emotion_stack_${index}.exp3.json`;
              compositeExpressionUrls.set(file, URL.createObjectURL(combined));
              emotionDefinitions.push({ Name: name, File: file });
              emotionStackNames.set(definition.Name, name);
            }
            emotionStackNames.set(SAVED_EXPRESSION_STACK_NAME, SAVED_EXPRESSION_STACK_NAME);
            aiExpressionStacksRef.current.set(renderModel.id, emotionStackNames);
            manifest = { ...resources.manifest, FileReferences: { ...resources.manifest.FileReferences, Expressions: [...expressions, { Name: SAVED_EXPRESSION_STACK_NAME, File: SAVED_EXPRESSION_STACK_FILE }, ...emotionDefinitions] } };
            resolveModelAsset = (reference) => compositeExpressionUrls.get(reference) ?? resources.resolve(reference);
          } else {
            setModelNotice("Saved expressions could not be combined with this model.");
            aiExpressionStacksRef.current.delete(renderModel.id);
          }
        } else {
          aiExpressionStacksRef.current.delete(renderModel.id);
        }
        const settings = new Cubism4ModelSettings(manifest);
        settings.resolveURL = resolveModelAsset;
        const model = await Live2DModel.from(settings, { autoInteract: false });
        ownedModel = model;
        if (disposed || loadId !== modelLoadIdRef.current) {
          model.destroy({ children: true, texture: true, baseTexture: true });
          ownedModel = undefined;
          releaseResources();
          return;
        }
        if (shouldApplyStack && !await model.expression(SAVED_EXPRESSION_STACK_NAME)) setModelNotice("Saved expressions could not be applied to this model.");
        if (canvasRef.current) {
          const stopWind = attachModelWind(canvasRef.current, model.internalModel as unknown as WindInternalModel);
          model.once("destroy", stopWind);
        }
        for (const texture of model.textures) {
          if (!texture.valid) throw new Error("A model texture did not finish loading. Please reload the model.");
          texture.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
          texture.baseTexture.wrapMode = PIXI.WRAP_MODES.CLAMP;
        }
        const restState = captureModelRestState(model.internalModel.coreModel as CubismRestModel);
        if (resources.texturePlan.some((plan) => plan.source.width !== plan.render.width || plan.source.height !== plan.render.height)) {
          const source = Math.max(...resources.texturePlan.flatMap((plan) => [plan.source.width, plan.source.height]));
          const render = Math.max(...resources.texturePlan.flatMap((plan) => [plan.render.width, plan.render.height]));
          setTextureSummary(`${render.toLocaleString()}px rendering · ${source.toLocaleString()}px original`);
        }
        const bounds = model.getLocalBounds();
        resizeModel = () => {
          const stage = canvasRef.current?.parentElement?.getBoundingClientRect();
          if (!stage) return;
          const width = Math.max(1, Math.round(stage.width));
          const height = Math.max(1, Math.round(stage.height));
          app.renderer.resolution = isAppleMobile ? appleResolution : Math.min(window.devicePixelRatio || 1, 2);
          app.renderer.resize(width, height);
          const baseScale = Math.min((width * (width > height ? .43 : .88)) / bounds.width, ((height - Math.min(124, height * .15)) * .88) / bounds.height);
          modelBaseScaleRef.current = baseScale;
          const transform = clampModelTransform(modelTransformRef.current, width, height);
          modelTransformRef.current = transform;
          model.scale.set(baseScale * transform.scale);
          // Models from different artists use different local origins. Pivot
          // from their measured bounds so none of them can land off-canvas.
          model.anchor.set(0, 0);
          model.pivot.set(bounds.x + bounds.width / 2, bounds.y + bounds.height);
          model.x = width / 2 + transform.x;
          model.y = height * .99 + transform.y;
        };
        app.stage.addChild(model);
        queueResize = () => {
          if (resizeFrame) cancelAnimationFrame(resizeFrame);
          if (resizeTimeout) window.clearTimeout(resizeTimeout);
          resizeFrame = requestAnimationFrame(() => requestAnimationFrame(resizeModel));
          resizeTimeout = window.setTimeout(resizeModel, 240);
        };
        handleOrientationChange = () => {
          queueResize();
        };
        queueResize();
        // If the artist did not supply a thumbnail, capture the rendered model.
        resizeModel();
        textureAbort.signal.throwIfAborted();
        if (loadId !== modelLoadIdRef.current) throw new DOMException("Superseded model", "AbortError");
        const previous = modelPresentationRef.current;
        if (previous) previous.model.visible = false;
        try { app.renderer.render(app.stage); }
        catch (error) { if (previous) previous.model.visible = true; throw error; }
        if (app.renderer.gl.isContextLost()) throw new Error("Graphics memory is unavailable. Try Auto texture quality and reload the model.");
        modelRef.current = model;
        modelRestStateRef.current = restState;
        modelPresentationRef.current = { model, dispose: () => {
          if (resizeFrame) cancelAnimationFrame(resizeFrame);
          if (resizeTimeout) window.clearTimeout(resizeTimeout);
          window.removeEventListener("resize", queueResize);
          window.removeEventListener("orientationchange", handleOrientationChange);
          window.visualViewport?.removeEventListener("resize", queueResize);
          app.stage.removeChild(model);
          model.destroy({ children: true, texture: true, baseTexture: true });
          releaseResources?.();
        } };
        promoted = true;
        previous?.dispose();
        finishTiming(renderTiming);
        finishTiming(modelSelectionTimingRef.current);
        finishTiming(startupTimingRef.current);
        window.dispatchEvent(new Event("vivian-model-first-frame"));
        setModelStatus("ready");
        setModelSwitchPending(false);
        startupModelResolvedRef.current = true;
        setStartupModelPending(false);
        clearRecovery();
        // Thumbnail for Character cards: supplied previews win, otherwise
        // snapshot the live render once. Capture the model tight (a stage
        // target renders to a RenderTexture synchronously — the reliable
        // path on iOS, where full-frame readbacks come back black) and crop
        // to the top so the face stays visible. Fire-and-forget so the
        // first frame is never delayed by thumbnail work.
        if (!renderModel.previewPath) {
          void (async () => {
            try {
              const Extract = (PIXI as any).Extract;
              if (!Extract) return;
              const extract = new Extract(app.renderer);
              const frame = extract.canvas(app.stage) as HTMLCanvasElement | undefined;
              if (!frame) return;
              const crop = faceCrop(
                { x: 0, y: 0, width: frame.width, height: frame.height },
                frame.width,
                frame.height,
              );
              const blob = await snapshotToBlob(frame, 360, 0.72, crop ?? undefined);
              if (!blob) return;
              if (disposed || loadId !== modelLoadIdRef.current) return;
              cacheSnapshotPreview(renderModel.id, blob);
            } catch { /* Card keeps its pink name fallback. */ }
          })();
        }
        window.addEventListener("resize", queueResize);
        window.addEventListener("orientationchange", handleOrientationChange);
        window.visualViewport?.addEventListener("resize", queueResize);
      } catch (error) {
        clearRecovery();
        cancelTiming(renderTiming);
        if (!disposed && loadId === modelLoadIdRef.current) cancelTiming(modelSelectionTimingRef.current);
        if (modelPresentationRef.current && !promoted) {
          modelPresentationRef.current.model.visible = true;
          if (!app?.renderer.gl.isContextLost()) app?.renderer.render(app.stage);
        }
        if (ownedModel && !promoted) {
          app?.stage.removeChild(ownedModel);
          ownedModel.destroy({ children: true, texture: true, baseTexture: true });
          if (modelRef.current === ownedModel) { modelRef.current = null; modelRestStateRef.current = null; }
          ownedModel = undefined;
        }
        if (!disposed && loadId === modelLoadIdRef.current) {
          console.error("Live2D failed to load", error);
          setModelStatus("error");
          startupModelResolvedRef.current = true;
          setStartupModelPending(false);
          setModelSwitchPending(false);
          setModelNotice(error instanceof Error ? error.message : "Could not render this model. Check that it is compatible with Cubism 4 and includes all assets.");
        }
        if (!promoted) releaseResources?.();
      }
    })();
    return () => {
      disposed = true;
      textureAbort.abort();
      if (modelRenderAbortRef.current === textureAbort) modelRenderAbortRef.current = null;
      clearBreadcrumb();
      modelLoadIdRef.current += 1;
      window.removeEventListener("pagehide", clearRecovery);
      if (!promoted) {
        if (resizeFrame) cancelAnimationFrame(resizeFrame);
        if (resizeTimeout) window.clearTimeout(resizeTimeout);
        window.removeEventListener("resize", queueResize);
        window.removeEventListener("orientationchange", handleOrientationChange);
        window.visualViewport?.removeEventListener("resize", queueResize);
      }
      cancelTiming(renderTiming);
      // A promoted model belongs to the stage until its replacement has rendered.
      // Pending candidates still release all textures/URLs when superseded.
      if (!promoted) {
        if (ownedModel && app) {
          app.stage.removeChild(ownedModel);
          ownedModel.destroy({ children: true, texture: true, baseTexture: true });
        }
        ownedModel = undefined;
        releaseResources?.();
      }
    };
  }, [preferencesReady, modelsReady, activeModel, activePackage, cloudLibrary, textureQuality, modelReload, graphicsLost, modelPaused]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const lost = (event: Event) => {
      event.preventDefault(); // Allow the browser to restore this context.
      pixiAppRef.current?.stop();
      setGraphicsLost(true);
      setModelStatus("error");
      setModelNotice("Graphics interrupted. The model will reload when graphics recover.");
    };
    const restored = () => {
      pixiAppRef.current?.start();
      setGraphicsLost(false);
      setModelNotice(null);
      setModelReload((value) => value + 1);
    };
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    return () => {
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragStart: { pointerId: number; x: number; y: number; offsetX: number; offsetY: number } | null = null;
    let dragMoved = 0;
    let pinchStart: { distance: number; midX: number; midY: number; scale: number; offsetX: number; offsetY: number } | null = null;
    let lastTapAt = 0;
    let dragging = false;
    let wheelPersistTimer: number | undefined;

    const setCursor = () => {
      canvas.style.cursor = dragging ? "grabbing" : "grab";
    };

    const stageSize = () => {
      const stage = canvas.parentElement?.getBoundingClientRect();
      return { width: Math.max(0, stage?.width ?? 0), height: Math.max(0, stage?.height ?? 0) };
    };

    const apply = () => {
      const model = modelRef.current;
      if (!model) return;
      const { width, height } = stageSize();
      if (!width || !height) return;
      modelTransformRef.current = clampModelTransform(modelTransformRef.current, width, height);
      model.x = width / 2 + modelTransformRef.current.x;
      model.y = height * 0.99 + modelTransformRef.current.y;
      model.scale.set((modelBaseScaleRef.current || 1) * modelTransformRef.current.scale);
    };

    const persist = () => {
      const activeId = activeModelIdRef.current;
      if (!activeId) return;
      saveModelTransform(activeId, { ...modelTransformRef.current });
    };

    const reset = () => {
      modelTransformRef.current = { x: 0, y: 0, scale: 1 };
      apply();
      persist();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!modelRef.current) return;
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* Pointer capture is best-effort. */
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 1) {
        dragStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offsetX: modelTransformRef.current.x, offsetY: modelTransformRef.current.y };
        dragMoved = 0;
        pinchStart = null;
        dragging = true;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStart = {
          distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          midX: (a.x + b.x) / 2,
          midY: (a.y + b.y) / 2,
          scale: modelTransformRef.current.scale,
          offsetX: modelTransformRef.current.x,
          offsetY: modelTransformRef.current.y,
        };
        dragStart = null;
        dragging = true;
      }
      setCursor();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!modelRef.current || !pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinchStart && pointers.size >= 2) {
        const [a, b] = [...pointers.values()].slice(0, 2);
        const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        modelTransformRef.current.scale = pinchStart.scale * (distance / pinchStart.distance);
        modelTransformRef.current.x = pinchStart.offsetX + (midX - pinchStart.midX);
        modelTransformRef.current.y = pinchStart.offsetY + (midY - pinchStart.midY);
        const { width, height } = stageSize();
        modelTransformRef.current = clampModelTransform(modelTransformRef.current, width, height);
        apply();
        return;
      }
      if (dragStart && dragStart.pointerId === event.pointerId) {
        dragMoved = Math.max(dragMoved, Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y));
        modelTransformRef.current.x = dragStart.offsetX + (event.clientX - dragStart.x);
        modelTransformRef.current.y = dragStart.offsetY + (event.clientY - dragStart.y);
        const { width, height } = stageSize();
        modelTransformRef.current = clampModelTransform(modelTransformRef.current, width, height);
        apply();
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      const wasDrag = dragStart !== null || pinchStart !== null;
      const hadPointers = pointers.has(event.pointerId);
      pointers.delete(event.pointerId);
      try {
        canvas.releasePointerCapture?.(event.pointerId);
      } catch {
        /* Already released when the gesture ended. */
      }
      if (pointers.size === 0) {
        if (wasDrag) persist();
        // Double-tap reset for touch (dblclick covers mouse).
        if (hadPointers && dragMoved < 8 && !pinchStart) {
          const now = Date.now();
          if (now - lastTapAt < 350) reset();
          lastTapAt = now;
        }
        dragStart = null;
        pinchStart = null;
        dragging = false;
      } else if (pointers.size === 1) {
        const [id, pos] = [...pointers.entries()][0];
        dragStart = { pointerId: id, x: pos.x, y: pos.y, offsetX: modelTransformRef.current.x, offsetY: modelTransformRef.current.y };
        dragMoved = 0;
        pinchStart = null;
      }
      setCursor();
    };

    const onDoubleClick = (event: MouseEvent) => {
      event.preventDefault();
      reset();
    };

    const onWheel = (event: WheelEvent) => {
      if (!modelRef.current) return;
      event.preventDefault();
      const zoom = Math.exp(-event.deltaY * 0.0012 * (event.ctrlKey || event.metaKey ? 1.6 : 1));
      modelTransformRef.current.scale *= zoom;
      const { width, height } = stageSize();
      modelTransformRef.current = clampModelTransform(modelTransformRef.current, width, height);
      apply();
      // Wheel fires many times per gesture; debounce the write.
      if (wheelPersistTimer !== undefined) window.clearTimeout(wheelPersistTimer);
      wheelPersistTimer = window.setTimeout(persist, 200);
    };

    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("dblclick", onDoubleClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("dblclick", onDoubleClick);
      canvas.removeEventListener("wheel", onWheel);
      canvas.style.cursor = "";
      pointers.clear();
      if (wheelPersistTimer !== undefined) window.clearTimeout(wheelPersistTimer);
    };
  }, []);

  useEffect(() => () => {
    modelSelectionAbortRef.current?.abort();
    cancelTiming(modelSelectionTimingRef.current); cancelTiming(startupTimingRef.current);
    modelPresentationRef.current?.dispose(); modelPresentationRef.current = null;
    modelRef.current = null; modelRestStateRef.current = null;
    // React owns this canvas; removing it breaks effect replay/remounting.
    pixiAppRef.current?.destroy(false, { children: true });
    pixiAppRef.current = null;
  }, []);

  useEffect(() => () => {
    micEnabledRef.current = false;
    stopRecording();
  }, []);

  async function loadMemory() {
    if (resettingRef.current) return;
    const generation = memoryGenerationRef.current;
    try {
      const response = await authFetch("/api/memory", { cache: "no-store" });
      const data = await response.json();
      if (generation !== memoryGenerationRef.current || resettingRef.current) return;
      if (Array.isArray(data.memories)) setMemories(data.memories);
      const next = normalizeCompanion(data.companion);
      if (next) setCompanion(next);
    } catch { /* Vivian stays usable while Supabase is unavailable. */ }
  }
  function normalizeCompanion(raw: unknown): CompanionState | null {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    const mood = String(item.mood ?? "calm");
    return decayCompanionState({
      affinity: Number(item.affinity ?? 22),
      trust: Number(item.trust ?? 18),
      familiarity: Number(item.familiarity ?? 8),
      mood: normalizeMood(mood),
      moodIntensity: Number(item.moodIntensity ?? item.mood_intensity ?? 35),
      conversationSummary: String(item.conversationSummary ?? item.conversation_summary ?? ""),
      lastIdleAt: typeof item.lastIdleAt === "string" ? item.lastIdleAt : typeof item.last_idle_at === "string" ? item.last_idle_at : null,
      lastInteractionAt: typeof item.lastInteractionAt === "string" ? item.lastInteractionAt : typeof item.last_interaction_at === "string" ? item.last_interaction_at : null,
    });
  }
  function markActivity() {
    lastActivityRef.current = Date.now();
  }
  function lastIdleAt() {
    const fromState = companionRef.current.lastIdleAt ? Date.parse(companionRef.current.lastIdleAt) : 0;
    const fromStore = Number(window.localStorage.getItem(LAST_IDLE_KEY) ?? 0);
    return Math.max(fromState || 0, fromStore || 0);
  }
  async function maybeIdleGreeting() {
    if (resettingRef.current || idleBusyRef.current || sendingRef.current || speakingRef.current || recordingRef.current) return;
    if (!interactedRef.current || document.hidden) return;
    if (Date.now() - lastActivityRef.current < IDLE_AFTER_MS) return;
    if (Date.now() - lastIdleAt() < IDLE_COOLDOWN_MS) return;
    idleBusyRef.current = true;
    try {
      await sendMessage("", { idle: true });
      window.localStorage.setItem(LAST_IDLE_KEY, String(Date.now()));
    } finally {
      idleBusyRef.current = false;
      markActivity();
    }
  }
  function stopSpeech() {
    speakIdRef.current += 1;
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    speakingRef.current = false;
    setSpeaking(false);
    stopLipSync();
    resetReaction();
  }
  function unlockAudio(): Promise<void> {
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return Promise.resolve();
    audioContextRef.current ??= new AudioContextClass();
    if (audioPrimedRef.current && audioContextRef.current.state !== "suspended") return Promise.resolve();
    if (audioUnlockPromiseRef.current) return withTimeout(audioUnlockPromiseRef.current, AUDIO_UNLOCK_MS, undefined);
    const context = audioContextRef.current;
    const audio = audioRef.current ?? new Audio();
    audio.setAttribute("playsinline", "true");
    audio.preload = "auto";
    if (!audio.src) audio.src = SILENT_WAV;
    audio.muted = true;
    audioRef.current = audio;
    const unlock = (async () => {
      if (context.state === "suspended") await withTimeout(context.resume().then(() => undefined), 800, undefined);
      try {
        await withTimeout(audio.play().then(() => undefined), AUDIO_UNLOCK_MS, undefined);
        audio.pause();
        audio.currentTime = 0;
      } catch { /* Safari may reject empty or delayed unlock; chat must still continue. */ }
      audio.muted = false;
      audioPrimedRef.current = true;
    })();
    audioUnlockPromiseRef.current = unlock.finally(() => { audioUnlockPromiseRef.current = null; });
    return audioUnlockPromiseRef.current;
  }
  function setMouthOpen(value: number) {
    const coreModel = modelRef.current?.internalModel?.coreModel;
    if (!coreModel) return;
    const mouth = Math.max(0, Math.min(1, value));
    try {
      coreModel.setParameterValueById("ParamMouthOpenY", mouth);
      // Some Cubism models expose mouth shape separately. It is optional, so
      // keep this best-effort and preserve compatibility with older models.
      try { coreModel.setParameterValueById("ParamMouthForm", (mouth - .5) * .18); } catch { /* optional parameter */ }
    } catch (error) { console.warn("Live2D mouth parameter unavailable", error); }
  }
  function resetReaction() {
    const expressionManager = modelRef.current?.internalModel?.motionManager?.expressionManager;
    expressionActionRef.current += 1;
    setActiveExpression(null);
    try {
      if (expressionManager) {
        // Cubism's resetExpression only resets playback. Clear its selection and
        // pending load too, so the same expression can be enabled again.
        expressionManager.reserveExpressionIndex = -1;
        expressionManager.currentExpression = expressionManager.defaultExpression;
        expressionManager.resetExpression();
      }
    } catch (error) { console.warn("Live2D default expression unavailable", error); }
    const saved = activeExpressionModelRef.current === activeModelIdRef.current ? activeExpressionsRef.current : [];
    const hasSavedStack = activeModelIdRef.current ? aiExpressionStacksRef.current.get(activeModelIdRef.current)?.has(SAVED_EXPRESSION_STACK_NAME) : false;
    if (saved.length && hasSavedStack) void modelRef.current?.expression(SAVED_EXPRESSION_STACK_NAME).catch((error: unknown) => console.warn("Saved Live2D expressions unavailable", error));
  }
  function stopLipSync() {
    if (lipSyncFrameRef.current !== null) cancelAnimationFrame(lipSyncFrameRef.current);
    lipSyncFrameRef.current = null;
    setMouthOpen(0);
  }
  function usesNativeAppleAudio() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function startNativeLipSync(audio: HTMLAudioElement) {
    // Do not route an iOS media element through AudioContext. Safari can show
    // playback in Dynamic Island while that routed output is silent. Native
    // playback is reliable; this keeps a lightweight visual mouth movement.
    stopLipSync();
    let smoothed = 0;
    let previousTime = audio.currentTime;
    const update = () => {
      if (audio.paused || audio.ended) { setMouthOpen(0); lipSyncFrameRef.current = null; return; }
      // iOS Safari must stay on native playback, so there is no safe analyser
      // stream here. Use playback-time pulses with attack/release smoothing;
      // this avoids the old harsh, constant jaw oscillation while keeping the
      // mouth moving in sync with the spoken audio.
      const delta = Math.max(0, audio.currentTime - previousTime);
      previousTime = audio.currentTime;
      const pulse = .08 + (Math.sin(audio.currentTime * 17) * .5 + .5) * .34 + (Math.sin(audio.currentTime * 31) * .5 + .5) * .12;
      const target = delta > .12 ? 0 : Math.min(.62, pulse);
      smoothed += (target - smoothed) * (target > smoothed ? .42 : .2);
      setMouthOpen(smoothed);
      lipSyncFrameRef.current = requestAnimationFrame(update);
    };
    lipSyncFrameRef.current = requestAnimationFrame(update);
  }
  function startLipSync(audio: HTMLAudioElement) {
    if (usesNativeAppleAudio()) { startNativeLipSync(audio); return; }
    const context = audioContextRef.current;
    if (!context) return;
    stopLipSync();
    const analyser = analyserRef.current ?? context.createAnalyser();
    if (!analyserRef.current) {
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = .72;
      analyserRef.current = analyser;
    }
    if (!mediaSourceRef.current) {
      const source = context.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(context.destination);
      mediaSourceRef.current = source;
    }
    const samples = new Uint8Array(analyser.fftSize);
    const spectrum = new Uint8Array(analyser.frequencyBinCount);
    let smoothed = 0;
    const update = () => {
      if (audio.paused || audio.ended) { setMouthOpen(0); lipSyncFrameRef.current = null; return; }
      analyser.getByteTimeDomainData(samples);
      analyser.getByteFrequencyData(spectrum);
      let rms = 0;
      for (const sample of samples) { const delta = (sample - 128) / 128; rms += delta * delta; }
      rms = Math.sqrt(rms / samples.length);
      let energy = 0;
      for (let index = 1; index < spectrum.length; index += 1) energy += spectrum[index];
      const spectralLevel = spectrum.length > 1 ? energy / ((spectrum.length - 1) * 255) : 0;
      const level = Math.min(1, rms * 4.8 + spectralLevel * 1.8);
      const target = Math.max(0, Math.min(.9, Math.pow(level, .72)));
      smoothed += (target - smoothed) * (target > smoothed ? .5 : .18);
      setMouthOpen(smoothed);
      lipSyncFrameRef.current = requestAnimationFrame(update);
    };
    lipSyncFrameRef.current = requestAnimationFrame(update);
  }
  async function speak(text: string, replyTiming?: LocalTiming): Promise<boolean> {
    if (mutedRef.current) { cancelTiming(replyTiming); return false; }
    const speakId = ++speakIdRef.current;
    const abort = new AbortController();
    ttsAbortRef.current = abort;
    speakingRef.current = true;
    setSpeaking(true);
    const timeout = window.setTimeout(() => abort.abort(), TTS_TIMEOUT_MS);
    let objectUrl: string | null = null;
    const ttsTiming = startTiming("tts_request_to_audio_start");
    const downloadTiming = startTiming("tts_request_to_audio_ready");
    let playbackTiming: LocalTiming | undefined;
    try {
      // Audio unlocking and provider generation are independent. Playback still
      // waits for unlocking before using the shared Safari audio element.
      const [ready] = await Promise.all([
        authFetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, signal: abort.signal, body: JSON.stringify({ text, voiceId: voiceIdRef.current, language: speechLanguageRef.current }) }).then(async (response) => {
          const blob = response.ok ? await withTimeout(response.blob(), TTS_TIMEOUT_MS, null) : null;
          if (blob?.size && speakId === speakIdRef.current) {
            finishTiming(downloadTiming, { serverTiming: response.headers.get("server-timing") ?? "unavailable" });
            playbackTiming = startTiming("audio_ready_to_playback");
          }
          return { response, blob };
        }),
        withTimeout(unlockAudio(), AUDIO_UNLOCK_MS, undefined),
      ]);
      const { response, blob } = ready;
      if (speakId !== speakIdRef.current) return false;
      if (!response.ok) {
        const error = await response.json().catch(() => null) as { error?: string; code?: string } | null;
        throw new Error(error?.code ?? error?.error ?? "TTS failed");
      }
      if (!blob || blob.size === 0) throw new Error("TTS failed");
      const audio = audioRef.current ?? new Audio();
      audioRef.current?.pause();
      if (audioRef.current?.src) audioRef.current.removeAttribute("src");
      objectUrl = URL.createObjectURL(blob);
      audio.src = objectUrl;
      audio.setAttribute("playsinline", "true");
      audio.muted = false;
      audio.defaultMuted = false;
      audio.volume = 1;
      audio.onended = () => {
        if (speakId === speakIdRef.current) { speakingRef.current = false; setSpeaking(false); }
        stopLipSync();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
      audio.onerror = () => {
        if (speakId === speakIdRef.current) { speakingRef.current = false; setSpeaking(false); }
        stopLipSync();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
      audioRef.current = audio;
      const started = await withTimeout(audio.play().then(() => true), PLAYBACK_START_MS, false);
      if (speakId !== speakIdRef.current) return false;
      if (!started) {
        stopLipSync();
        throw new Error("TTS playback did not start");
      }
      finishTiming(ttsTiming); finishTiming(replyTiming); finishTiming(playbackTiming);
      // Start the animation only after playback begins. Starting it before
      // audio.play() lets the first frame see `paused` and permanently stop.
      startLipSync(audio);
      await new Promise<void>((resolve) => window.setTimeout(resolve, AUDIO_SYNC_SETTLE_MS));
      return speakId === speakIdRef.current;
    } catch (error) {
      if (speakId === speakIdRef.current) {
        speakingRef.current = false;
        setSpeaking(false);
        if ((error as { name?: string }).name !== "AbortError") {
          resetReaction();
          console.error("TTS unavailable", error);
        }
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      return false;
    } finally {
      cancelTiming(ttsTiming); cancelTiming(replyTiming); cancelTiming(downloadTiming); cancelTiming(playbackTiming);
      window.clearTimeout(timeout);
      if (ttsAbortRef.current === abort) ttsAbortRef.current = null;
    }
  }
  async function sendMessage(overrideText?: string, options: { idle?: boolean; visionIdle?: boolean; image?: string } = {}) {
    const idle = Boolean(options.idle);
    const visionIdle = Boolean(options.visionIdle);
    const text = (overrideText ?? message).trim();
    let imageToSend = options.image ?? attachedImage;
    if (cameraActiveRef.current && !idle && !visionIdle) {
      const liveFrame = captureCurrentFrame();
      if (liveFrame) {
        imageToSend = liveFrame;
      }
    }
    if (sendingRef.current || resettingRef.current || !history.ready) return;
    if (!idle && !visionIdle && !text && !imageToSend) return;
    if (!idle && !visionIdle) {
      greetingGenerationRef.current += 1;
      greetingRequestRef.current?.abort();
      greetingTextRef.current = null;
    }
    if (!idle && !visionIdle && text && await handleExpressionCommand(text)) {
      setMessage("");
      setAttachedImage(null);
      markActivity();
      return;
    }
    if (speakingRef.current) stopSpeech();
    markActivity();
    if (!idle && !visionIdle) interactedRef.current = true;
    const displayText = text || (imageToSend ? "[ส่งรูปภาพ]" : "");
    const nextMessages = (idle || visionIdle) ? messagesRef.current : [...messagesRef.current.filter((item) => item.text !== GREETING_PENDING), historyMessage("me", displayText)];
    if (!idle && !visionIdle) {
      setMessages(nextMessages);
      setMessage("");
      setAttachedImage(null);
    }
    setSending(true);
    sendingRef.current = true;
    const sceneGeneration = sceneLibrary.getGeneration();
    const replyMessageId = crypto.randomUUID();
    const requestConversationId = activeConversationRef.current;
    const firstTokenTiming = startTiming("send_to_first_token");
    const replyTiming = startTiming("send_to_reply");
    try {
      const response = await authFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        signal: abortAfter(CHAT_TIMEOUT_MS),
        body: JSON.stringify({
          mode: visionIdle ? "vision_idle" : idle ? "idle" : "chat",
          conversationId: requestConversationId,
          conversationCreate: !history.isCloudConversation(requestConversationId),
          conversationTitle: conversations.find((item) => item.id === requestConversationId)?.title ?? (text.slice(0, 42) || "Daily Talk"),
          userMessageId: nextMessages.filter((item) => item.from === "me").at(-1)?.id,
          assistantMessageId: replyMessageId,
          messages: nextMessages.filter((item) => item.text !== GREETING_PENDING).map((item) => ({ role: item.from === "me" ? "user" : "assistant", content: item.text })),
          image: imageToSend ?? undefined,
          character: selectedModel,
          customInstructions: customInstructionsRef.current,
          language: speechLanguageRef.current,
        }),
      });
      const { data, ok } = await readChatResponse<{ scene?: SceneDecision; text?: string; error?: string; code?: string; memories?: Memory[]; companion?: CompanionState }>(response, (provider, timing) => {
        const elapsed = performance.now() - (firstTokenTiming?.start ?? performance.now());
        finishTiming(firstTokenTiming, {
          provider, ...(timing ?? {}),
          ...(timing ? { transportAndClientMs: Math.max(0, elapsed - timing.preparationMs - timing.providerMs) } : {}),
        });
      });
      finishTiming(replyTiming);
      if (!ok || !data?.text) throw new Error(data?.code ?? data?.error ?? "Chat request failed");
      sceneLibrary.applyChatScene(data.scene, sceneGeneration);
      const reply = data.text;
      setErrorNotice(null);
      // Do not reveal the reply bubble before TTS playback has started. This
      // keeps the visible text and spoken response arriving together.
      if (!muted) await speak(reply, startTiming("reply_to_audio_start"));
      setMessages((current) => [...current, historyMessage("vivian", reply, replyMessageId)]);
      const nextCompanion = normalizeCompanion(data.companion);
      if (nextCompanion) setCompanion(nextCompanion);
      if (data.memories?.length) setMemories(data.memories.filter((item: Memory) => typeof item.id === "number"));
      setSending(false);
      sendingRef.current = false;
      void playReaction(reply, text, idle || visionIdle);
      void loadMemory();
    } catch (error) {
      console.error("Vivian response unavailable", error);
      resetReaction();
      if (!idle && !visionIdle) {
        const message = error instanceof Error && error.message.includes("RATE_LIMITED") ? "หยุดส่งข้อความ รอให้ระบบพร้อมก่อน"
          : error instanceof Error && error.message === "SEARCH_UNAVAILABLE" ? "ระบบค้นหาขัดข้อง ตอนนี้ใช้ไม่ได้"
          : error instanceof Error && error.message === "CHAT_NOT_CONFIGURED" ? "ระบบสนทนายังไม่พร้อม"
          : "การเชื่อมต่อขาด รอจนกว่าจะกลับมา";
        setErrorNotice(message);
        setMessages((current) => [...current, historyMessage("vivian", message)]);
      }
    } finally {
      cancelTiming(firstTokenTiming); cancelTiming(replyTiming);
      setSending(false);
      sendingRef.current = false;
    }
  }
  // Thin adapter kept for the old call shape: the scoring engine lives in
  // lib/live2d-emotion so it is testable without booting the whole client.
  function situationEmotion(reply: string, userText: string, mood: Mood, intensity: number, idle: boolean) {
    return detectLive2DEmotion({ reply, userText, mood, intensity, idle });
  }
  async function handleExpressionCommand(text: string) {
    const match = text.match(/^\/(?:expression|exp)(?:\s+(.+))?$/i);
    if (!match) return false;
    const argument = match[1]?.trim() ?? "";
    const expressions = (activeModel?.expressions ?? []);
    if (argument.toLowerCase() === "list") {
      setMessages((current) => [...current, historyMessage("me", text), historyMessage("vivian", `นี่ มีแค่นี้แหละ: ${expressions.join(", ")} จะเลือกอะไรก็เลือกสิ`)]);
      return true;
    }
    if (!argument || argument.toLowerCase() === "default" || argument.toLowerCase() === "reset") {
      clearSavedExpressions();
      setMessages((current) => [...current, historyMessage("me", text), historyMessage("vivian", "กลับเป็นค่าปกติแล้ว")]);
      return true;
    }
    const expression = expressions.find((item) => item.trim().toLowerCase() === argument.toLowerCase());
    if (!expression) {
      setMessages((current) => [...current, historyMessage("me", text), historyMessage("vivian", "ไม่มี expression ชื่อนั้น ตรวจ /expression list")]);
      return true;
    }
    try {
      if (!modelRef.current) throw new Error("Live2D model is not ready");
      const selected = activeExpressionModelRef.current === activeModel?.id ? activeExpressionsRef.current : [];
      if (!selected.includes(expression)) saveExpressionSelection([...selected, expression]);
      setMessages((current) => [...current, historyMessage("me", text), historyMessage("vivian", `จำ ${expression.trim()} ไว้แล้ว`)]);
    } catch (error) {
      console.warn("Manual Live2D expression unavailable", error);
      resetReaction();
      setMessages((current) => [...current, historyMessage("me", text), historyMessage("vivian", "เปลี่ยนไม่ได้ โมเดลยังไม่พร้อม")]);
    }
    return true;
  }
  async function playReaction(reply: string, userText: string, idle = false) {
    const model = modelRef.current;
    if (!model) return;
    const { mood, moodIntensity: intensity } = companionRef.current;
    const supportedExpressions = activeModel?.expressions ?? [];
    // Tags first, then mood, then words. A model with no matching face keeps
    // its last reaction instead of flashing back to neutral every turn.
    const emotion = situationEmotion(reply, userText, mood, intensity, idle);
    const expression = resolveLive2DExpression(emotion, supportedExpressions);
    try {
      if (expression) {
        const expressionStacks = activeModel ? aiExpressionStacksRef.current.get(activeModel.id) : undefined;
        const stackedName = expressionStacks?.get(expression);
        if (expressionStacks?.has(SAVED_EXPRESSION_STACK_NAME) && !stackedName) {
          await model.expression(SAVED_EXPRESSION_STACK_NAME);
        } else {
          const applied = await model.expression(stackedName ?? expression);
          if (applied) setActiveExpression(expression);
        }
      }
      else if (!supportedExpressions.length) resetReaction();
      const definitions = model.internalModel?.motionManager?.definitions ?? {};
      const groups = Object.keys(definitions).filter((name) => Array.isArray(definitions[name]) && definitions[name].length);
      const motionName = resolveLive2DMotion(emotion, groups);
      if (motionName) await model.motion(motionName, 0, intensity >= 70 ? 3 : 2);
    } catch (error) {
      resetReaction();
      console.warn("Live2D reaction unavailable; keeping neutral state", error);
    }
  }
  async function startRecording() {
    if (resettingRef.current || recording || recorderRef.current) return;
    const generation = memoryGenerationRef.current;
    if (speakingRef.current) stopSpeech();
    markActivity();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      // A push-to-talk hold can be released while Safari's permission prompt is
      // still pending. Do not leave a late-resolving stream recording in the
      // background after the user has already released the orb.
      if (generation !== memoryGenerationRef.current || !micEnabledRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const chunks: BlobPart[] = [];
      const preferredMimeTypes = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
      const mimeType = preferredMimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 128000 });
      recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
      recorder.onstop = async () => {
        // Automatic rearming waits for Vivian to finish, and never survives reset.
        const resumeListening = () => {
          if (generation !== memoryGenerationRef.current || resettingRef.current || !micEnabledRef.current || recordingRef.current) return;
          if (speakingRef.current || sendingRef.current) {
            window.setTimeout(resumeListening, 250);
            return;
          }
          void startRecording();
        };
        if (generation !== memoryGenerationRef.current) { recorderRef.current = null; streamRef.current = null; return; }
        const durationMs = Date.now() - recordingStartedAtRef.current;
        const actualMimeType = recorder.mimeType || mimeType || "audio/webm";
        const extension = actualMimeType.includes("mp4") ? "m4a" : "webm";
        if (durationMs < MIN_RECORDING_MS || !chunks.length || (voiceActivityRef.current && !voiceActivityRef.current.heardSpeech)) {
          setSttPreview("ยังไม่มีเสียงที่ชัดพอค่ะ");
          window.setTimeout(() => setSttPreview(null), 2500);
          recorderRef.current = null;
          streamRef.current = null;
          window.setTimeout(resumeListening, 250);
          return;
        }
        const form = new FormData();
        form.append("file", new Blob(chunks, { type: actualMimeType }), `vivian-recording.${extension}`);
        const speechEnd = voiceActivityRef.current?.quietSince;
        const start = speechEnd === null || speechEnd === undefined ? performance.now() : Math.max(0, performance.now() - (Date.now() - speechEnd));
        const transcriptTiming = startTiming("speech_end_to_transcript", start);
        const endpointTiming = startTiming("speech_end_to_stt_request", start);
        const sttTiming = startTiming("stt_request_to_transcript");
        finishTiming(endpointTiming);
        try {
          form.append("language", speechLanguageRef.current);
          const response = await authFetch("/api/stt", { method: "POST", body: form, signal: abortAfter(STT_TIMEOUT_MS) });
          const data = await response.json() as { text?: string; error?: string };
          if (generation !== memoryGenerationRef.current) return;
          if (!response.ok) throw new Error(data.error ?? "STT failed");
          if (data.text?.trim()) {
            finishTiming(transcriptTiming);
            finishTiming(sttTiming, { serverTiming: response.headers.get("server-timing") ?? "unavailable" });
            setSttPreview(data.text);
            void sendMessage(data.text);
            window.setTimeout(() => setSttPreview(null), 5000);
          } else throw new Error("STT returned no speech");
        } catch (error) {
          console.warn("STT unavailable", error);
          setSttPreview("ฟังไม่ชัด ลองพูดใหม่อีกครั้งนะคะ");
          window.setTimeout(() => setSttPreview(null), 3000);
        } finally {
          cancelTiming(transcriptTiming); cancelTiming(sttTiming);
          recorderRef.current = null;
          streamRef.current = null;
          window.setTimeout(resumeListening, 250);
        }
      };
      voiceActivityRef.current = null;
      recorder.start();
      recorderRef.current = recorder;
      streamRef.current = stream;
      recordingStartedAtRef.current = Date.now();
      recordingRef.current = true;
      setRecording(true);
      // Keep the recorder open and split speech into utterances using local
      // voice activity detection. Only the resulting clip is sent to STT.
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        const voiceContext = new AudioContextClass();
        voiceContextRef.current = voiceContext;
        void voiceContext.resume().catch(() => {});
        const analyser = voiceContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = .75;
        voiceSourceRef.current = voiceContext.createMediaStreamSource(stream);
        voiceSourceRef.current.connect(analyser);
        voiceAnalyserRef.current = analyser;
        const samples = new Uint8Array(analyser.fftSize);
        const activity = createVoiceActivity();
        voiceActivityRef.current = activity;
        const monitor = () => {
          if (!recordingRef.current || recorderRef.current !== recorder) return;
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) { const delta = sample - 128; sum += delta * delta; }
          const rms = Math.sqrt(sum / samples.length) / 128;
          micAmplitude.set(Math.min(1, rms * 7));
          if (updateVoiceActivity(activity, rms, Date.now())) { stopRecording(); return; }
          voiceMonitorRef.current = requestAnimationFrame(monitor);
        };
        voiceMonitorRef.current = requestAnimationFrame(monitor);
      }
    } catch {
      micAmplitude.set(0);
      micEnabledRef.current = false;
      resetReaction();
      setMessages((current) => [...current, historyMessage("vivian", "ยังไม่ได้รับสิทธิ์ใช้ไมโครโฟนค่ะ")]);
    }
  }
  function stopRecording() {
    micAmplitude.set(0);
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (voiceMonitorRef.current !== null) cancelAnimationFrame(voiceMonitorRef.current);
    voiceMonitorRef.current = null;
    voiceSourceRef.current?.disconnect();
    voiceSourceRef.current = null;
    voiceAnalyserRef.current = null;
    void voiceContextRef.current?.close().catch(() => {});
    voiceContextRef.current = null;
    recordingRef.current = false;
    setRecording(false);
  }
  function toggleRecording() {
    if (micEnabledRef.current) {
      micEnabledRef.current = false;
      stopRecording();
    } else {
      micEnabledRef.current = true;
      void startRecording();
    }
  }

  function captureCurrentFrame(): string | null {
    const video = videoRef.current;
    if (!video) return null;
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    if (!vw || !vh) return null;

    try {
      const canvas = document.createElement("canvas");
      const maxDim = 800;
      let width = vw;
      let height = vh;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, width, height);
      return canvas.toDataURL("image/jpeg", 0.75);
    } catch (err) {
      console.warn("captureCurrentFrame error", err);
      return null;
    }
  }

  useEffect(() => {
    const video = videoRef.current;
    if (cameraActive && video && videoStreamRef.current) {
      if (video.srcObject !== videoStreamRef.current) {
        video.srcObject = videoStreamRef.current;
      }
      video.muted = true;
      video.play().catch((err) => console.warn("Camera play failed", err));
    }
  }, [cameraActive]);

  async function startCamera(facing: "user" | "environment" = cameraFacing) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: facing },
        audio: false,
      });
      videoStreamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.muted = true;
        await video.play().catch((err) => console.warn("Initial camera play failed", err));
      }
      setCameraFacing(facing);
      setCameraActive(true);
      cameraActiveRef.current = true;
      lastVisionTriggerRef.current = Date.now();
    } catch (err) {
      console.error("Camera access failed", err);
      setErrorNotice("ไม่สามารถเปิดกล้องได้ กรุณาอนุญาตการเข้าถึงกล้องนะคะ");
    }
  }

  function stopCamera() {
    videoStreamRef.current?.getTracks().forEach((track) => track.stop());
    videoStreamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
    cameraActiveRef.current = false;
    if (visionTimerRef.current) window.clearTimeout(visionTimerRef.current);
    visionTimerRef.current = null;
  }

  async function toggleCamera() {
    if (cameraActive) {
      stopCamera();
    } else {
      await startCamera();
    }
  }

  async function switchCamera() {
    const nextFacing = cameraFacing === "user" ? "environment" : "user";
    // Stop current tracks before switching
    videoStreamRef.current?.getTracks().forEach((track) => track.stop());
    videoStreamRef.current = null;
    await startCamera(nextFacing);
  }

  function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setErrorNotice("กรุณาเลือกไฟล์รูปภาพนะคะ");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const rawData = reader.result as string;
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const maxDim = 800;
        let width = img.width;
        let height = img.height;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          const compressed = canvas.toDataURL("image/jpeg", 0.75);
          setAttachedImage(compressed);
        } else {
          setAttachedImage(rawData);
        }
      };
      img.onerror = () => {
        setAttachedImage(rawData);
      };
      img.src = rawData;
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  useEffect(() => {
    if (!cameraActive) {
      if (visionTimerRef.current) window.clearTimeout(visionTimerRef.current);
      visionTimerRef.current = null;
      return;
    }
    let isMounted = true;
    function scheduleNextCapture() {
      const delay = Math.floor(Math.random() * (VISION_MAX_INTERVAL_MS - VISION_MIN_INTERVAL_MS + 1)) + VISION_MIN_INTERVAL_MS;
      visionTimerRef.current = window.setTimeout(async () => {
        if (!isMounted || !cameraActiveRef.current) return;
        const now = Date.now();
        const timeSinceLast = now - lastVisionTriggerRef.current;
        if (
          timeSinceLast >= VISION_COOLDOWN_MS &&
          !sendingRef.current &&
          !speakingRef.current &&
          !recordingRef.current &&
          !message.trim()
        ) {
          const frame = captureCurrentFrame();
          if (frame) {
            lastVisionTriggerRef.current = Date.now();
            await sendMessage("", { visionIdle: true, image: frame });
          }
        }
        if (isMounted && cameraActiveRef.current) {
          scheduleNextCapture();
        }
      }, delay);
    }
    scheduleNextCapture();
    return () => {
      isMounted = false;
      if (visionTimerRef.current) window.clearTimeout(visionTimerRef.current);
      visionTimerRef.current = null;
    };
  }, [cameraActive, message]);

  async function saveMemory(memory: Memory) {
    const response = await authFetch("/api/memory", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: memory.id, memory: memoryDraft, category: memory.category, importance: memory.importance }) });
    if (!response.ok) return setErrorNotice("บันทึกความจำไม่สำเร็จค่ะ");
    const data = await response.json() as { memory?: Memory };
    if (data.memory) setMemories((current) => current.map((item) => item.id === memory.id ? data.memory! : item));
    setEditingMemoryId(null);
  }

  async function resetVivian(): Promise<void> {
    if (sendingRef.current || resettingRef.current || !history.ready) return;
    setResetConfirming(false);
    resettingRef.current = true;
    memoryGenerationRef.current += 1;
    setResetting(true);
    setResetNotice(null);
    greetingGenerationRef.current += 1;
    greetingRequestRef.current?.abort();
    greetingTextRef.current = null;
    stopSpeech();
    micEnabledRef.current = false;
    stopRecording();
    stopCamera();
    try {
      await history.pause();
      const response = await authFetch("/api/memory", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: "all" }) });
      if (!response.ok) throw new Error("Reset failed");
      const data = await response.json() as { ok?: boolean };
      if (data.ok !== true) throw new Error("Reset unconfirmed");
      for (const key of [CONVERSATIONS_KEY, "vivian-active-conversation", "vivian-checkin-date", "vivian-streak", LAST_IDLE_KEY, "vivian-custom-instructions"]) window.localStorage.removeItem(key);
      const id = crypto.randomUUID();
      window.localStorage.setItem("vivian-active-conversation", id);
      setActiveConversationId(id);
      history.clear();
      initialGreeting.current = historyMessage("vivian", "...ไง เริ่มคุยกันใหม่ได้เลยนะ");
      setMessages([]);
      setMemories([]);
      setCompanion(defaultCompanionState());
      resetCustomInstructions();
      setStreak(0);
      setMessage("");
      setAttachedImage(null);
      setSttPreview(null);
      setEditingMemoryId(null);
      setMemoryDraft("");
      setConversationSearch("");
      setErrorNotice(null);
      markActivity();
      interactedRef.current = false;
      setResetNotice("รีเซ็ตแล้ว เริ่มคุยกันใหม่ได้เลยนะ");
    } catch {
      setResetNotice("รีเซ็ตไม่สำเร็จทั้งหมด ลองอีกครั้งนะ แชตบนอุปกรณ์นี้ยังไม่ได้ล้าง");
    } finally {
      resettingRef.current = false;
      setResetting(false);
      history.resume();
    }
  }

  function openPanel(next: Panel) {
    panelRef.current = next;
    sidebarOpenRef.current = true;
    try { window.sessionStorage.setItem("vivian-open-panel", next); } catch { /* Storage restrictions do not block navigation. */ }
    setPanel(next);
    setSidebarOpen(true);
    if (next === "conversations") void history.refresh();
  }
  function openMenuHub() {
    panelRef.current = null;
    try { window.sessionStorage.removeItem("vivian-open-panel"); } catch { /* Ignore unavailable storage. */ }
    setPanel(null);
    sidebarOpenRef.current = true;
    setSidebarOpen(true);
  }
  function backToNavigation(event: ReactMouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    openMenuHub();
  }
  function closeMenu() {
    panelRef.current = null;
    sidebarOpenRef.current = false;
    try { window.sessionStorage.removeItem("vivian-open-panel"); } catch { /* Ignore unavailable storage. */ }
    setPanel(null);
    setSidebarOpen(false);
  }
  function closeNavigation(event: ReactMouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    closeMenu();
  }
  useEffect(() => { panelRef.current = panel; sidebarOpenRef.current = sidebarOpen; }, [panel, sidebarOpen]);
  useEffect(() => {
    try {
      const savedPanel = window.sessionStorage.getItem("vivian-open-panel");
      if (savedPanel && ["conversations", "memories", "character", "scenes", "voice", "status", "settings"].includes(savedPanel)) {
        panelRef.current = savedPanel as Panel;
        sidebarOpenRef.current = true;
        setPanel(savedPanel as Panel);
        setSidebarOpen(true);
      }
    } catch { /* Storage restrictions do not block navigation. */ }
  }, []);
  useEffect(() => {
    if (!sidebarOpen || !panel || !window.matchMedia("(max-width: 760px)").matches) return;
    window.history.pushState({ vivianMenu: true, panel }, "");
    const onHardwareBack = () => {
      if (panelRef.current) {
        panelRef.current = null;
        setPanel(null);
        setSidebarOpen(true);
      } else if (sidebarOpenRef.current) {
        sidebarOpenRef.current = false;
        setSidebarOpen(false);
      }
    };
    window.addEventListener("popstate", onHardwareBack);
    return () => window.removeEventListener("popstate", onHardwareBack);
  }, [sidebarOpen, panel]);
  function selectConversation(conversation: Conversation) {
    if (sending || resettingRef.current || !history.ready) return;
    setErrorNotice(null);
    greetingGenerationRef.current += 1;
    greetingRequestRef.current?.abort();
    greetingTextRef.current = null;
    setActiveConversationId(conversation.id);
    window.localStorage.setItem("vivian-active-conversation", conversation.id);
    setMessages(conversation.messages);
    closeMenu();
  }
  function newConversation() {
    if (sending || resettingRef.current || !history.ready) return;
    setErrorNotice(null);
    greetingGenerationRef.current += 1;
    greetingRequestRef.current?.abort();
    greetingTextRef.current = null;
    greetingSpokenRef.current = false;
    const id = crypto.randomUUID();
    setActiveConversationId(id);
    window.localStorage.setItem("vivian-active-conversation", id);
    setMessages([{ from: "vivian", text: GREETING_PENDING }]);
    setGreetingTrigger((value) => value + 1);
    closeMenu();
  }
  const navigation: Array<{ key: Panel; label: string; icon: IconName }> = [
    { key: "conversations", label: "Conversations", icon: "message" },
    { key: "memories", label: "Memories", icon: "memory" },
    { key: "character", label: "Character", icon: "wardrobe" },
    { key: "scenes", label: "Scenes", icon: "scene" },
    { key: "voice", label: "Voice", icon: "sound" },
    { key: "status", label: "Status", icon: "status" },
    { key: "settings", label: "Settings", icon: "config" },
  ];
  // One shared state vocabulary for the orb: it follows radio/TTS/mic reality.
  const orbState: AIState =
    errorNotice
      ? "error"
      : sending
        ? "thinking"
        : speaking
          ? "streaming"
          : recording
            ? "listening"
            : "idle";
  function toggleTextInput() {
    setTextOpen((open) => {
      if (!open && recordingRef.current) toggleRecording();
      return !open;
    });
  }
  // ---- Orb interaction: double tap = quick-actions row, press & hold = talk (STT). ----
  function setRadialVisible(open: boolean) {
    radialOpenRef.current = open;
    setRadialOpen(open);
  }
  function closeOrbRadial() {
    setRadialVisible(false);
  }
  useEffect(() => {
    if (!radialOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".orb-toolbar, .orb-button")) return;
      closeOrbRadial();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [radialOpen]);
  function closeComposer() {
    // Closing the composer resets its draft: text and attachment clear.
    setAttachedImage(null);
    setMessage("");
    setTextOpen(false);
  }
  function runOrbDirection(action: OrbDirection) {
    setRadialVisible(false);
    // Picking mic, camera or the menu hub folds the text pill away first, so
    // the composer never floats open behind the action you chose.
    if (action === "mic") { closeComposer(); toggleRecording(); }
    else if (action === "camera") { closeComposer(); void toggleCamera(); }
    else if (action === "type") { if (textOpen) closeComposer(); else setTextOpen(true); }
    else { closeComposer(); openMenuHub(); }
  }
  function onOrbPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    void event.currentTarget.setPointerCapture(event.pointerId);
    orbPointerRef.current = { x: event.clientX, y: event.clientY };
    if (radialOpenRef.current) return; // toolbar is open: taps select buttons, no PTT
    // Arm push-to-talk: a short hold starts recording, a quick tap does not.
    if (orbHoldTimerRef.current !== null) window.clearTimeout(orbHoldTimerRef.current);
    orbHoldTimerRef.current = window.setTimeout(() => {
      orbHoldTimerRef.current = null;
      orbPttActiveRef.current = true;
      if (!micEnabledRef.current) {
        micEnabledRef.current = true;
        void startRecording();
      }
    }, 220);
  }
  function onOrbPointerEnd(event: ReactPointerEvent<HTMLButtonElement>) {
    void event.currentTarget.releasePointerCapture?.(event.pointerId);
    orbPointerRef.current = null;
    if (orbHoldTimerRef.current !== null) { window.clearTimeout(orbHoldTimerRef.current); orbHoldTimerRef.current = null; }
    if (orbPttActiveRef.current) {
      orbPttActiveRef.current = false;
      if (micEnabledRef.current) {
        micEnabledRef.current = false;
        stopRecording();
      }
      orbLastTapRef.current = 0;
      return;
    }
    if (radialOpenRef.current) {
      // The quick-action row is selected by tapping its buttons directly.
      closeOrbRadial();
      orbLastTapRef.current = 0;
      return;
    }
    // A quick tap: the second tap inside 320ms opens the quick-action row.
    const now = Date.now();
    if (orbLastTapRef.current && now - orbLastTapRef.current <= 320) {
      orbLastTapRef.current = 0;
      setRadialVisible(true);
    } else {
      orbLastTapRef.current = now;
    }
  }

  // Show Vivian preloader while a Live2D model is loading — on startup,
  // while switching models, and while the renderer builds the first frame.
  const live2dLoading = startupModelPending || modelSwitchPending || modelStatus === "loading";

  return <main className="companion-shell">
    <PagePreloader
      active={live2dLoading}
      variant="words"
      background="bg-background/90 backdrop-blur-sm"
      words={["รอฉันแป๊บนึงนะคะ...", "วิเวียนกำลังเตรียมตัวให้สวยอยู่", "อย่าไปไหนนะ... ฉันจะมา", "แค่เธอคนเดียว รอได้ใช่ไหมคะ", "เกือบพร้อมแล้วค่ะ"]}
      onComplete={() => {}}
    />
    <section className={`companion-stage ${MODEL_CONFIG[selectedModel].background} ${!sending && !recording ? "is-idle" : ""}`} aria-label="Vivian companion">
      <SceneBackground source={sceneLibrary.scenes.find((scene) => scene.id === activeCustomSceneId)?.imageUrl ?? BACKGROUNDS[selectedPreset]} preview={sceneLibrary.scenes.find((scene) => scene.id === activeCustomSceneId)?.thumbnailUrl} timing={sceneLibrary.selectionTiming} />
      <canvas className="live2d-canvas" ref={canvasRef} />
      <header className="companion-brand">
        <button className="brand-menu" type="button" onClick={openMenuHub} aria-label="เปิดเมนู Vivian (แชต ความจำ ท่าทาง ฉาก เสียง สถานะ)">
          <span className="brand-mark" aria-hidden="true"/><span>Vivian</span>
        </button>
      </header>
      <div className="camera-pip" style={{ display: cameraActive ? "flex" : "none" }} aria-label="Live Camera Vision">
        <div className="camera-pip-header">
          <div className="live-badge">
            <span className="live-dot" aria-hidden="true" />
            <span>{cameraFacing === "environment" ? "REAR CAM" : "LIVE VISION"}</span>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button type="button" onClick={switchCamera} aria-label="สลับกล้อง" title="สลับกล้องหน้า/หลัง">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 7H4m0 0l4-4M4 7l4 4M4 17h16m0 0-4 4m4-4-4-4"/>
              </svg>
            </button>
            <button type="button" onClick={stopCamera} aria-label="ปิดกล้อง">×</button>
          </div>
        </div>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="camera-video-feed"
          style={{ transform: cameraFacing === "environment" ? "none" : "scaleX(-1)" }}
          onLoadedMetadata={(e) => {
            e.currentTarget.play().catch((err) => console.warn("Video play on metadata blocked", err));
          }}
        />
      </div>
      <div className="speech-stack">
        {sttPreview && <div className="speech-preview"><small>You said</small>{sttPreview}</div>}
        <output className={`vivian-speech ${sending ? "is-thinking" : ""}`} aria-live="polite">
          {sending
            ? <span className="speech-transition" key="thinking"><span>Vivian กำลังคิด</span><span className="thinking-dots" aria-hidden="true"><i/><i/><i/></span></span>
            : <span className="speech-transition" key={lastVivianMessage}>{lastVivianMessage}</span>}
        </output>
      </div>
      {errorNotice && <button className="error-notice" type="button" onClick={() => setErrorNotice(null)}>{errorNotice} ×</button>}
      {attachedImage && (
        <div className="attachment-preview" aria-label="รูปภาพที่แนบ">
          <img src={attachedImage} alt="Attachment preview" />
          <span>แนบรูปภาพแล้ว</span>
          <button type="button" onClick={() => setAttachedImage(null)} aria-label="ลบรูปภาพ">×</button>
        </div>
      )}
      {textOpen && <button className="composer-scrim" type="button" tabIndex={-1} aria-label="ปิดช่องพิมพ์" onClick={closeComposer} />}
      <div className="orb-dock">
        <form className={`composer-pill ${textOpen ? "is-open" : ""}`} onSubmit={(event) => { event.preventDefault(); void sendMessage(); }} inert={!textOpen}>
          <button className="circle-control" type="button" onClick={() => fileInputRef.current?.click()} aria-label="แนบรูปภาพ"><Icon name="clip" size={18}/></button>
          <input value={message} onChange={(event) => setMessage(event.target.value)} autoFocus={textOpen} placeholder={recording ? "กำลังฟัง... กดไมค์เพื่อ Mute" : cameraActive ? "กล้อง Live กำลังทำงาน... พิมพ์คุยได้" : "Talk to Vivian"} aria-label="ข้อความถึง Vivian" />
          <button className="send-text" type="submit" disabled={sending || !history.ready || (!message.trim() && !attachedImage)} aria-label="ส่งข้อความ"><Icon name="send" size={18}/></button>
        </form>
        <div className="orb-row">
          {radialOpen && <div className="orb-toolbar" role="toolbar" aria-label="ทางลัดของ Vivian">
            {ORB_DIRECTIONS.map((item) => (
              <button
                key={item.key}
                type="button"
                className="orb-direction"
                aria-label={item.label}
                onPointerDown={(event) => event.stopPropagation()}
                onPointerUp={(event) => event.stopPropagation()}
                onClick={() => runOrbDirection(item.key)}
              >
                <span
                  className={`circle-control ${
                    item.key === "mic" && recording
                      ? "is-recording"
                      : item.key === "camera" && cameraActive
                      ? "is-active is-camera-active"
                      : item.key === "type" && textOpen
                      ? "is-active"
                      : ""
                  }`}
                  aria-hidden="true"
                >
                  <Icon name={item.key === "mic" && recording ? "micOff" : item.icon} size={18}/>
                </span>
                <small>{item.label}</small>
              </button>
            ))}
          </div>}
          <button
            className="orb-button"
            type="button"
            onPointerDown={onOrbPointerDown}
            onPointerUp={onOrbPointerEnd}
            onPointerCancel={onOrbPointerEnd}
            onContextMenu={(event) => event.preventDefault()}
            aria-label="กดค้างเพื่อพูดกับ Vivian แตะสองครั้งเพื่อเปิดทางลัด (mic cam chat setting)"
            aria-expanded={radialOpen}
          >
            <SiriOrb size="62px" state={orbState} amplitude={recording ? micAmplitude : 0} />
          </button>
        </div>
        <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleImageUpload} tabIndex={-1} />
      </div>
    </section>
    <div className={`floating-overlay ${sidebarOpen ? "is-visible" : ""}`} aria-hidden={!sidebarOpen}>
      <button className="floating-scrim" type="button" tabIndex={sidebarOpen ? 0 : -1} onClick={closeMenu} aria-label="Close sidebar" />
      <div className="floating-workspace menu-window">
        <section className="floating-panel" role="dialog" aria-modal="true" aria-label={panel ? navigation.find((item) => item.key === panel)?.label : "Vivian menu"}>
          <div className="floating-panel-head">{panel && <button className="settings-back" type="button" onClick={backToNavigation} aria-label="Back to menu"><svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg></button>}<div><small>{panel ? `VIVIAN / ${panel.toUpperCase()}` : "VIVIAN / MENU"}</small><h2>{panel ? navigation.find((item) => item.key === panel)?.label : "Menu"}</h2></div><button type="button" onClick={closeNavigation} aria-label="Close menu"><Icon name="close" size={18}/></button></div>
          {modelImporting && panel === "character" && <div className={`floating-panel-loadbar${typeof modelImportProgress?.percent === "number" ? " is-determinate" : " is-indeterminate"}`} aria-hidden="true"><span style={typeof modelImportProgress?.percent === "number" ? { width: `${modelImportProgress.percent}%` } : undefined} /></div>}
          <div className="floating-panel-body">
            {!panel && <>
              <button type="button" className="floating-new-chat" onClick={newConversation}><Icon name="plus" size={17}/> New Chat</button>
              <div className="floating-menu-list">{navigation.map((item) => <button key={item.key} type="button" className="floating-nav-item" onClick={() => openPanel(item.key)}><Icon name={item.icon} size={18}/><span>{item.label}</span><span className="nav-chevron"><Icon name="chevron" size={16}/></span></button>)}</div>
            </>}
            {panel === "conversations" && <>
              <label className="floating-search"><Icon name="search" size={17}/><input value={conversationSearch} onChange={(event) => setConversationSearch(event.target.value)} placeholder="Search conversations" /></label>
              <div className="conversation-list">{conversations.filter((item) => item.title.toLowerCase().includes(conversationSearch.toLowerCase()) || item.messages.some((entry) => entry.text.toLowerCase().includes(conversationSearch.toLowerCase()))).sort((a, b) => b.updatedAt - a.updatedAt).map((conversation) => <button key={conversation.id} type="button" className={conversation.id === activeConversationId ? "is-selected" : ""} onClick={() => selectConversation(conversation)}><span className="conversation-avatar">V</span><span><strong>{conversation.title}</strong><small>{conversation.messages.at(-1)?.text ?? "Start chatting with Vivian"}</small></span><time>{new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(conversation.updatedAt)}</time></button>)}</div>
              {messages.some((item) => item.text !== GREETING_PENDING) && <details className="cloud-history"><summary>Messages in this conversation</summary><div className="chat-history">{messages.filter((item) => item.text !== GREETING_PENDING).map((item, index) => <div className={`chat-message ${item.from}`} key={item.id ?? index}><small>{item.from === "me" ? "You" : "Vivian"}</small><p>{item.text}</p></div>)}</div></details>}
              {!conversations.length && <p className="floating-empty">Your conversations will appear here.</p>}
              <p role="status">{!history.ready ? "Loading chat history…" : history.notice ?? "Chat history · Supabase"}</p><p className="floating-note">Conversations sync through Supabase across devices. Local copies keep unsynced messages available.</p>
            </>}
            {panel === "memories" && <>
              <div className="bond-panel"><p><strong>Daily check-in</strong> {streak} days together</p><p><strong>Mood</strong>{moodLabel(companion.mood)}</p>{[["Affinity", companion.affinity], ["Trust", companion.trust], ["Familiarity", companion.familiarity]].map(([label, value]) => <div key={String(label)}><span>{label}</span><i><b style={{ width: `${value}%` }}/></i><em>{value}</em></div>)}</div>
              <div className="memory-list">{memories.length ? memories.map((memory) => <article key={memory.id}><Icon name="memory" size={18}/>{editingMemoryId === memory.id ? <div className="memory-edit"><textarea value={memoryDraft} maxLength={500} onChange={(event) => setMemoryDraft(event.target.value)}/><div><button type="button" onClick={() => void saveMemory(memory)}>Save</button><button type="button" onClick={() => setEditingMemoryId(null)}>Cancel</button></div></div> : <><p><strong>{memory.category}</strong>{memory.memory}</p><button type="button" className="memory-edit-button" onClick={() => { setEditingMemoryId(memory.id); setMemoryDraft(memory.memory); }}>Edit</button></>}</article>) : <p className="floating-empty">Nothing has caught Vivian&apos;s attention yet.</p>}</div>
            </>}
            {panel === "character" && <>
              <div className="floating-tabs">{(["outfit", "expression", "pose"] as const).map((tab) => <button key={tab} type="button" className={characterTab === tab ? "is-selected" : ""} onClick={() => setCharacterTab(tab)}>{tab === "outfit" ? "Models" : tab}</button>)}</div>
              {characterTab === "outfit" && <>
                {modelCarouselItems.length > 0 ? <CoverflowCarousel
                  ariaLabel="Live2D models"
                  className={modelImporting ? "pointer-events-none opacity-60" : "character-model-carousel"}
                  depth={90}
                  index={modelCarouselIndex}
                  items={modelCarouselItems}
                  onIndexChange={(index) => {
                    const entry = modelCarouselEntries[index];
                    if (entry && entry.model.id !== activeModelId) {
                      setPendingModelId(entry.model.id);
                      void chooseModel(entry.model.id);
                    }
                  }}
                  rotation={32}
                  spacing={155}
                /> : <div className="character-preview character-preview-empty"><strong>Your character awaits</strong><small>Import a Live2D model to begin.</small></div>}
                {activeModel && <p className="floating-note model-carousel-status" role="status"><span className={`load-dot ${live2dBusy ? "is-loading" : modelStatus === "ready" ? "is-ready" : "is-error"}`} aria-hidden="true" />{live2dBusy ? "Loading Live2D model…" : modelStatus === "ready" ? `Live2D Loaded — ${activeModel.expressions.length} expressions · ${activeModel.motions.length} motions` : "Model not loaded"}</p>}
                {activeModel && <label className="model-select-label">Texture quality<select value={textureQuality} onChange={(event) => { setModelNotice(null); setTextureQuality(event.target.value as "auto" | "original"); }}><option value="auto">Auto · fit this device</option><option value="original">Original textures</option></select></label>}
                {activeModel && <button type="button" className="floating-option" disabled={modelStatus === "loading" || graphicsLost || modelImporting} onClick={() => { void (async () => { setModelNotice(null); if (modelPaused) { setTextureQuality("auto"); await chooseModel(activeModel.id); } setModelPaused(false); setModelReload((value) => value + 1); })(); }}>Reload model</button>}
                {activeModel && <button type="button" className="floating-option" disabled={modelStatus !== "ready"} onClick={resetModelTransform}>Reset position & zoom</button>}
                {activeModel && <p className="floating-note">Drag the model to move it · pinch or scroll to zoom · double-click / double-tap to reset.</p>}
                {textureSummary && <p className="floating-note">{textureSummary}. Original files stay unchanged.</p>}
                <AnimatedFileUpload
                  key={`model-upload-${modelUploadKey}`}
                  accept=".zip"
                  className="vivian-upload"
                  disabled={modelImporting || !modelsReady}
                  maxSize={512 * 1024 * 1024}
                  multiple={false}
                  onFilesSelected={(files) => {
                    const zip = files[0];
                    if (!zip) return;
                    void importModels([zip]).finally(() => setModelUploadKey((value) => value + 1));
                  }}
                  progress={modelImporting ? modelImportProgress : null}
                />
                <div className="model-import-actions">
                  <button className="floating-option" type="button" disabled={modelImporting || !modelsReady} onClick={() => modelFolderRef.current?.click()}>Choose an unpacked folder instead</button>
                </div>
                <input ref={modelFolderRef} hidden type="file" multiple {...{ webkitdirectory: "", directory: "" }} onChange={(event) => { const input = event.currentTarget; const files = Array.from(input.files ?? []); void importModels(files).finally(() => { input.value = ""; }); }} />
                <p className="floating-note">{cloudLibrary ? "New imports are saved privately to cloud and cached on this device." : "Models are saved on this device while cloud sync is unavailable."} Include the .model3.json, .moc3, textures and animation files. Up to 512 MiB per package.</p>
                {cloudLibrary && <p className="floating-note">Models + scenes: {((cloudLibrary.usage.live2d.used + cloudLibrary.usage.other.used) / 1e9).toFixed(2)} / 8 GB shared. 2 GB stays unused as a safety buffer. Pending uploads count toward the budget.</p>}
                {activePackage && cloudLibrary && !cloudLibrary.models.some((model) => model.id === activePackage.id) && <button className="floating-option" type="button" disabled={modelImporting} onClick={() => { void saveActiveModelToCloud(); }}>Save this model to cloud</button>}
                {activePackage && <button className="floating-option model-remove" type="button" disabled={modelImporting} onClick={() => { void removeActiveModel(); }}>{cloudLibrary?.models.some((model) => model.id === activePackage.id) ? "Delete this package from cloud and this device" : "Remove this package from browser"}</button>}
              </>}
              {characterTab === "expression" && <>
                <button type="button" className="floating-option" disabled={modelStatus !== "ready" || !activeExpressions.length} onClick={clearSavedExpressions}>Reset saved expressions</button>
                <p className="floating-note">Choose one or more expressions. Vivian will restore the combined selection when this model loads.</p>
                <div className="expression-grid">{activeModel?.expressions.map((expression, index) => <button type="button" key={`${expression}:${index}`} disabled={modelStatus !== "ready"} aria-pressed={activeExpressionsModelId === activeModel.id && activeExpressions.includes(expression)} onClick={() => toggleSavedExpression(expression)}>{expression.trim()}</button>)}</div>
                {!activeModel?.expressions.length && <p className="floating-note">{activeModel ? "This model does not include expressions." : "Import a model in Models to discover its expressions."}</p>}
              </>}
              {characterTab === "pose" && <>
                <button type="button" className="floating-option" disabled={modelStatus !== "ready"} onClick={() => { resetReaction(); void selectMotion(null); }}>Reset to idle pose</button>
                {!!activeModel?.poses?.length && <><p className="floating-note">Poses</p><div className="expression-grid">{activeModel.poses.map((pose) => <button type="button" key={pose} disabled={modelStatus !== "ready"} aria-pressed={activeExpressionsModelId === activeModel.id && activeExpressions.includes(pose)} onClick={() => toggleSavedExpression(pose)}>{pose}</button>)}</div></>}
                {[...new Set(activeModel?.motions.map((motion) => motion.group) ?? [])].map((group) => <div className="model-motion-group" key={group}><p className="floating-note">{group || "Default"}</p><div className="expression-grid">{activeModel?.motions.filter((motion) => motion.group === group).map((motion) => <button type="button" key={motion.index} disabled={modelStatus !== "ready"} aria-pressed={activeMotion === `${group}:${motion.index}`} onClick={() => { if (activeMotion === `${group}:${motion.index}`) { resetReaction(); void selectMotion(null); } else void selectMotion(motion); }}>{motion.name}</button>)}</div></div>)}
                {!activeModel?.motions.length && !activeModel?.poses?.length && <p className="floating-note">{activeModel ? "This model does not include playable motions." : "Import a model in Models to discover its motions."}</p>}
              </>}
              {modelNotice && <p className="model-notice" role="alert">{modelNotice}</p>}
            </>}
            {panel === "scenes" && <><SceneManager library={sceneLibrary}/><p className="floating-note">Default backgrounds</p><div className="scene-grid">{(Object.keys(BACKGROUNDS) as Array<keyof typeof BACKGROUNDS>).map((scene) => <button key={scene} type="button"  className={!activeCustomSceneId && selectedPreset === scene ? "is-selected" : ""} onClick={() => selectPresetScene(scene)}><span style={{ backgroundImage: `url(${BACKGROUNDS[scene]})` }}/><strong>Christmas {scene}</strong></button>)}</div></>}
            {panel === "voice" && <>
              <button type="button" className="floating-option" onClick={() => setMuted((value) => !value)}>
                <Icon name="sound" size={18}/> Vivian voice <strong>{muted ? "Off" : "On"}</strong>
              </button>
              <div className="custom-instructions voice-id-preferences">
                <strong>11Labs Voice ID</strong>
                <p>Voice ID ที่ใช้งานอยู่ตอนนี้ (Global): <code style={{ color: "#241329", background: "#e0d6ff", padding: "2px 6px", borderRadius: "4px" }}>{voiceId || "Default (System)"}</code></p>
                <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
                  <input
                    type="text"
                    value={voiceIdInput}
                    placeholder="ใส่ 11Labs Voice ID..."
                    onChange={(e) => setVoiceIdInput(e.target.value)}
                    style={{ flex: 1, padding: "8px 12px", borderRadius: "10px", border: "1px solid rgba(36,19,41,0.2)", background: "rgba(255,255,255,0.65)", color: "#241329", font: "inherit", fontSize: "13px" }}
                  />
                  <button
                    type="button"
                    className="floating-option"
                    style={{ margin: 0, padding: "8px 14px" }}
                    onClick={() => saveVoiceId(voiceIdInput)}
                  >
                    Save
                  </button>
                </div>
              </div>
              <p role="status">{voiceNotice || "บันทึกแล้ว (Global)"}</p>
              {voiceNotice.includes("ไม่ได้") || voiceNotice.includes("ไม่สำเร็จ") ? (
                <button type="button" onClick={() => { if (voiceNotice.includes("โหลด")) void refreshVoicePreferences(); else saveVoiceId(voiceIdInput); }}>ลองอีกครั้ง</button>
              ) : null}
              <button type="button" className="floating-option" onClick={() => setLanguageOpen(true)}>
                <Icon name="language" size={18}/> Speech language <strong>{speechLanguage.toUpperCase()}</strong>
              </button>
              <button type="button" className="floating-option" onClick={toggleRecording}>
                <Icon name="mic" size={18}/> Microphone <strong>{recording ? "Listening" : "Start"}</strong>
              </button>
            </>}
             {panel === "status" && <StorageStatusPanel/>}
              {panel === "settings" && <><div className="custom-instructions"><strong>Reset Vivian</strong><p>ล้างความจำ แชต Mood และความสัมพันธ์บนคลาวด์ที่ใช้ร่วมกัน รวมถึงประวัติแชตและคำแนะนำส่วนตัวที่ซิงก์ทุกเครื่อง</p>{resetConfirming ? <div role="alertdialog" aria-label="ยืนยันรีเซ็ต Vivian"><p>ข้อมูลนี้จะถูกลบถาวรจากคลาวด์ที่ใช้ร่วมกันและแชตบนอุปกรณ์นี้ โมเดล การตั้งค่าเสียง และบัญชีล็อกอินจะยังอยู่</p><button type="button" className="floating-option" disabled={sending || resetting || savingCustomInstructions} onClick={() => { void resetVivian(); }}>ยืนยันรีเซ็ต Vivian</button><button type="button" className="floating-option" onClick={() => setResetConfirming(false)}>ยกเลิก</button></div> : <button type="button" className="floating-option" disabled={sending || resetting || savingCustomInstructions} onClick={() => setResetConfirming(true)}>{resetting ? "กำลังรีเซ็ต…" : "Reset memories and companion"}</button>}{resetNotice && <p role="status">{resetNotice}</p>}</div><div className="custom-instructions"><strong>Custom instructions</strong><p>How should Vivian speak with you? Saved to your account and synced across devices.</p><textarea value={customInstructions} maxLength={2000} onChange={(event) => updateCustomInstructions(event.target.value)} placeholder="Call me… Speak in Thai…"/><div className="custom-instructions-actions"><button type="button" className="floating-option" disabled={savingCustomInstructions} onClick={() => { void saveCustomInstructions(); }}>{savingCustomInstructions ? "Saving…" : "Save"}</button><span role="status">{customInstructionsNotice || (!customInstructionsSynced ? "กำลังซิงก์…" : customInstructionsDirty ? "ยังไม่ได้บันทึก" : "ซิงก์ทุกเครื่องแล้ว")}</span></div></div><button type="button" className="floating-option" onClick={() => setLanguageOpen(true)}><Icon name="language" size={18}/> Language <strong>{speechLanguage.toUpperCase()}</strong></button><button type="button" onClick={() => setInfoOpen(true)} className="floating-option"><Icon name="info" size={18}/> About Vivian</button></>}
            {panel === "settings" && <div className="account-settings"><div><small>ลงชื่อเข้าใช้ด้วย</small><p>{accountEmail}</p></div><button type="button" onClick={async () => { const token = window.localStorage.getItem("vivian_auth_token"); window.localStorage.removeItem("vivian_auth_token"); if (token) { try { await fetch("https://vivianauth.celestiasora.workers.dev/api/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }); } catch { /* best effort */ } } window.location.assign("/login"); }}>ออกจากระบบ <span aria-hidden="true">↗</span></button></div>}
          </div>
        </section>
      </div>
    </div>
    {languageOpen && <div className="chat-backdrop" role="presentation" onClick={() => setLanguageOpen(false)}><section className="info-sheet language-sheet" role="dialog" aria-modal="true" aria-label="ล็อกภาษาการพูด" onClick={(event) => event.stopPropagation()}><div className="memory-sheet-head"><div><small>LANGUAGE LOCK</small><h1>ภาษาการพูด</h1><p>ใช้ภาษาเดียวกันทั้งฟังเสียงและตอบด้วยเสียง</p></div><button type="button" onClick={() => setLanguageOpen(false)} aria-label="ปิด"><Icon name="close"/></button></div><div className="language-options">{LANGUAGE_OPTIONS.map((option) => <button key={option.code} type="button" className={speechLanguage === option.code ? "is-selected" : ""} onClick={() => { saveLanguage(option.code); setLanguageOpen(false); }}><strong>{option.nativeName}</strong><span>{option.label} · {option.code.toUpperCase()}</span></button>)}</div></section></div>}
    {infoOpen && <div className="chat-backdrop" role="presentation" onClick={() => setInfoOpen(false)}><section className="info-sheet" role="dialog" aria-modal="true" aria-label="ข้อมูลเวอร์ชัน" onClick={(event) => event.stopPropagation()}><div className="memory-sheet-head"><div><small>VIVIAN INFO</small><h1>ข้อมูลเวอร์ชัน</h1><p>ข้อมูลของ companion เวอร์ชันที่กำลังใช้งาน</p></div><button type="button" onClick={() => setInfoOpen(false)} aria-label="ปิด"><Icon name="close"/></button></div><div className="info-list"><p><strong>App</strong>Vivian AI Companion</p><p><strong>Codename</strong>{APP_CODENAME}</p><p><strong>Version</strong>vivian 2.3.2</p><p><strong>Character</strong>Nothing</p></div></section></div>}
  </main>;
}
