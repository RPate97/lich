// app.jsx — root component, tweaks wiring, stack arrival logic

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": ["#a78bfa", "#4ade80"],
  "numStacks": 5,
  "logVariant": "stream",
  "density": "regular",
  "sidebarStyle": "default"
}/*EDITMODE-END*/;

const ACCENT_OPTIONS = [
  ["#a78bfa", "#4ade80"],   // necro purple + phylactery green (default)
  ["#4ade80", "#a78bfa"],   // green-led, purple secondary
  ["#22d3ee", "#a78bfa"],   // cyan + purple
  ["#fb923c", "#a78bfa"],   // amber + purple
];

function applyAccent([primary, secondary]) {
  const root = document.documentElement;
  root.style.setProperty("--lich-purple", primary);
  root.style.setProperty("--lich-green", secondary);
  // derived glow / dim
  root.style.setProperty("--lich-purple-glow", lighten(primary, 0.18));
  root.style.setProperty("--lich-green-glow", lighten(secondary, 0.18));
}
// Quick HSL nudge — enough for a glow tint without pulling in a color lib.
function lighten(hex, amt) {
  const n = parseInt(hex.replace("#", ""), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.round(r + (255 - r) * amt);
  g = Math.round(g + (255 - g) * amt);
  b = Math.round(b + (255 - b) * amt);
  return `#${[r,g,b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // ── Stacks state ─────────────────────────────────────────────────────────
  // Re-seed when numStacks changes
  const [stacks, setStacks] = React.useState(() => makeStacks(t.numStacks));
  const lastNumRef = React.useRef(t.numStacks);
  const [arrivedIds, setArrivedIds] = React.useState(() => new Set());

  // Selection — auto-pick newest on FIRST load only
  const [selectedId, setSelectedId] = React.useState(() => stacks[0]?.id);

  // When numStacks changes via tweak, regenerate the seed (and re-auto-select
  // newest, since the prior selection may no longer exist).
  React.useEffect(() => {
    if (lastNumRef.current === t.numStacks) return;
    lastNumRef.current = t.numStacks;
    const fresh = makeStacks(t.numStacks);
    setStacks(fresh);
    setSelectedId(fresh[0]?.id);
    // Stagger arrivals so the list visibly settles after a numStacks change
    setArrivedIds(new Set(fresh.map((s) => s.id)));
    setTimeout(() => setArrivedIds(new Set()), 900);
  }, [t.numStacks]);

  // On very first mount: stagger-animate all stacks in (subtle ambience)
  React.useEffect(() => {
    const ids = new Set(stacks.map((s) => s.id));
    setArrivedIds(ids);
    const to = setTimeout(() => setArrivedIds(new Set()), 900);
    return () => clearTimeout(to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply accent on mount + whenever it changes
  React.useEffect(() => { applyAccent(t.accent); }, [t.accent]);

  // Density + sidebar style as data-attrs on root
  React.useEffect(() => {
    document.documentElement.dataset.density = t.density;
    document.documentElement.dataset.sidebarStyle = t.sidebarStyle;
  }, [t.density, t.sidebarStyle]);

  // ── Simulate a brand-new stack arrival ───────────────────────────────────
  const spawnStack = React.useCallback(() => {
    setStacks((prev) => {
      const nextIdx = prev.length;
      const newStack = buildStack(nextIdx, nextIdx);
      // Make it actually new (just arrived)
      newStack.startedAt = Date.now() - 3000;
      newStack.id = `stk_${Date.now().toString().slice(-5)}`;
      const sorted = [newStack, ...prev];
      // Mark arrival but DON'T switch selection (per spec)
      setArrivedIds(new Set([newStack.id]));
      setTimeout(() => setArrivedIds(new Set()), 900);
      return sorted;
    });
  }, []);

  const selected = stacks.find((s) => s.id === selectedId) ?? stacks[0];
  const newestId = stacks[0]?.id;

  return (
    <div className="app">
      <Sidebar
        stacks={stacks}
        selectedId={selected?.id}
        onSelect={setSelectedId}
        newestId={newestId}
        arrivedIds={arrivedIds}
      />
      {selected ? (
        <Main stack={selected} logVariant={t.logVariant} />
      ) : (
        <main className="main">
          <div className="empty">No stacks running. Start one with <span className="kbd">lich up</span>.</div>
        </main>
      )}

      <TweaksPanel title="Tweaks">
        <TweakSection label="Theme" />
        <TweakColor
          label="Accent"
          value={t.accent}
          options={ACCENT_OPTIONS}
          onChange={(v) => setTweak("accent", v)}
        />

        <TweakSection label="Layout" />
        <TweakRadio
          label="Density"
          value={t.density}
          options={["compact", "regular", "comfy"]}
          onChange={(v) => setTweak("density", v)}
        />
        <TweakRadio
          label="Sidebar"
          value={t.sidebarStyle}
          options={["default", "cards", "minimal"]}
          onChange={(v) => setTweak("sidebarStyle", v)}
        />

        <TweakSection label="Logs" />
        <TweakRadio
          label="Variant"
          value={t.logVariant}
          options={["stream", "table", "grouped"]}
          onChange={(v) => setTweak("logVariant", v)}
        />

        <TweakSection label="Mock data" />
        <TweakSlider
          label="Stack count"
          value={t.numStacks}
          min={1} max={9} step={1}
          onChange={(v) => setTweak("numStacks", v)}
        />
        <TweakButton label="Simulate new stack arrival" onClick={spawnStack} />
      </TweaksPanel>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
