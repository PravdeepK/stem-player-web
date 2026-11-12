import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { CacheEntry, FeedbackType } from "@stem-player-web/core";
import FeedbackDialog from "../components/FeedbackDialog";
import Mixer, { type MeterStyle } from "../components/Mixer";
import { useAudioMixer } from "../hooks/useAudioMixer";
import { DEMO_CREDIT, NOT_AFFILIATED, SITE_DESCRIPTION, SITE_NAME } from "../lib/site";
import { stemApi } from "../lib/stemApi";

// The device is the whole screen; loading and the waveforms live in a slide-out
// menu, opened from the hamburger or the device's plain edge button. Every way
// of getting a song (the demo, a recent one, a picked folder) ends in openSong,
// so a Separate section would only need to call it too. There isn't one while
// stemApi.separate() has no server behind it.

// Picked stems have no cache id. Only the demo is ever `demo`.
type Song = Pick<CacheEntry, "title" | "stems" | "demo"> & { id?: string };

const METER_STYLES: [MeterStyle, string][] = [
  ["dots", "Dots"],
  ["wave", "Waveform"],
  ["off", "Off"],
];
// The corner meter's style is a per-viewer convenience, so it lives in localStorage.
const METER_STORAGE_KEY = "stem-player.meter-style";
const DEFAULT_METER_STYLE: MeterStyle = "dots";

// localStorage throws in some private modes and when site data is blocked.
// Then the default is used and a new choice lasts until the page reloads.
function readMeterStyle(): MeterStyle {
  try {
    const saved = localStorage.getItem(METER_STORAGE_KEY);
    return METER_STYLES.find(([id]) => id === saved)?.[0] ?? DEFAULT_METER_STYLE;
  } catch {
    return DEFAULT_METER_STYLE;
  }
}

function saveMeterStyle(next: MeterStyle) {
  try {
    localStorage.setItem(METER_STORAGE_KEY, next);
  } catch (err) {
    console.warn("[meter] style not saved:", err);
  }
}

// Read once on the client after hydration, so the prerendered page and the
// first client render agree on the default.
const noSubscription = () => () => {};
const serverMeterStyle = () => DEFAULT_METER_STYLE;

export default function Home() {
  const [song, setSong] = useState<Song | null>(null);
  const [recents, setRecents] = useState<CacheEntry[]>([]);
  const [loadNote, setLoadNote] = useState("");
  // The name the last export was saved as.
  const [exported, setExported] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackType | null>(null);
  const savedMeterStyle = useSyncExternalStore(noSubscription, readMeterStyle, serverMeterStyle);
  const [chosenMeterStyle, setChosenMeterStyle] = useState<MeterStyle | null>(null);
  const meterStyle = chosenMeterStyle ?? savedMeterStyle;

  const mixer = useAudioMixer();

  const toggleMenu = useCallback(() => setMenuOpen((open) => !open), []);
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const closeFeedback = useCallback(() => setFeedback(null), []);

  useEffect(() => {
    stemApi.listRecent().then(setRecents);
  }, []);

  function chooseMeterStyle(next: MeterStyle) {
    setChosenMeterStyle(next);
    saveMeterStyle(next);
  }

  async function openSong(next: Song) {
    setSong(next);
    setExported(null);
    setExportNote("");
    setLoadNote("");
    await mixer.load(next.stems);
    setMenuOpen(false);
    setRecents(await stemApi.listRecent());
  }

  async function handlePlayDemo() {
    setLoadNote("");
    const r = await stemApi.openDemo();
    if (r.ok) await openSong(r.entry);
    else if (!r.canceled) setLoadNote(r.message);
  }

  async function handleOpenRecent(id: string) {
    const entry = await stemApi.openRecent(id);
    if (entry) {
      await openSong(entry);
    } else {
      // The browser can clear site storage on its own, so a listed song can be gone.
      setLoadNote("That song is no longer saved in this browser.");
      setRecents(await stemApi.listRecent());
    }
  }

  async function handleLoadStems() {
    setLoadNote("");
    const r = await stemApi.pickStemsFolder();
    if (!r.ok) {
      if (!r.canceled) setLoadNote(r.message);
      return;
    }
    // Picked files have no folder, and so no name to go on.
    await openSong({ title: r.dir || "Untitled", stems: r.stems, demo: false });
  }

  async function handleExport() {
    if (!song) return;
    setExportNote("");
    const r = await stemApi.exportStems(song.stems, song.title);
    if (r.ok) setExported(r.name);
    else if (!r.canceled) setExportNote(r.message);
  }

  const busy = mixer.isLoading;
  const activity = busy ? "Loading stems…" : "";

  const menu = (
    <>
      <header className="head">
        <h1 className="title">{SITE_NAME}</h1>
      </header>

      <section className="section">
        <div className="load-actions">
          <button className="primary" onClick={handlePlayDemo} disabled={busy}>
            Play Demo Song
          </button>
          <button className="secondary" onClick={handleLoadStems} disabled={busy}>
            Open Stems Folder…
          </button>
        </div>
        {loadNote && <p className="err">{loadNote}</p>}
        {mixer.error && <p className="err">{mixer.error}</p>}
      </section>

      {recents.length > 0 && (
        <section className="section">
          <h2 className="section-title">Recent</h2>
          <div className="group">
            {recents.map((r) => (
              <button
                key={r.id}
                className="group-row recent"
                disabled={busy}
                aria-current={song?.id === r.id ? "true" : undefined}
                onClick={() => handleOpenRecent(r.id)}
              >
                <span className="row-value">{r.title}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <h2 className="section-title">Main Screen</h2>
        <div className="group">
          <div className="group-row">
            <span className="row-label">Level Meter</span>
            <div className="segmented" role="radiogroup" aria-label="Level meter style">
              {METER_STYLES.map(([id, label]) => (
                <button
                  key={id}
                  role="radio"
                  aria-checked={meterStyle === id}
                  className={meterStyle === id ? "on" : ""}
                  onClick={() => chooseMeterStyle(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <footer className="about">
        <p>
          {SITE_DESCRIPTION} {NOT_AFFILIATED}
        </p>
      </footer>
    </>
  );

  const stemsActions = (
    <>
      <div className="stems-head">
        <h2 className="section-title">Stems</h2>
        <button className="secondary small" onClick={handleExport} disabled={!song || song.demo}>
          Export Stems…
        </button>
      </div>
      {song?.demo && <p className="footnote stems-note">The demo song can’t be exported.</p>}
      {exported && (
        <div className="notice">
          <span>Exported as “{exported}”</span>
        </div>
      )}
      {exportNote && <p className="err">{exportNote}</p>}
    </>
  );

  return (
    <main className="wrap">
      <Mixer
        mixer={mixer}
        title={song ? song.title : ""}
        activity={activity}
        menu={menu}
        stemsActions={stemsActions}
        meterStyle={meterStyle}
        menuOpen={menuOpen}
        onMenuToggle={toggleMenu}
        onMenuOpen={openMenu}
        onMenuClose={closeMenu}
        onFeedback={setFeedback}
      />
      {song?.demo && (
        <footer className="credit">
          <span>Song: {DEMO_CREDIT.song}</span>
          <span>{DEMO_CREDIT.provider}</span>
          <span>
            Free Download/Stream:{" "}
            <a href={DEMO_CREDIT.download} target="_blank" rel="noreferrer">
              {DEMO_CREDIT.download}
            </a>
          </span>
          <span>
            Watch:{" "}
            <a href={DEMO_CREDIT.watch} target="_blank" rel="noreferrer">
              {DEMO_CREDIT.watch}
            </a>
          </span>
        </footer>
      )}
      <FeedbackDialog type={feedback} onClose={closeFeedback} />
    </main>
  );
}
