import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import {
  DEFAULT_DOUBLE_CLICK_MS,
  HOLD_MS,
  createGrooveGestures,
  type StemMap,
  type StemName,
} from "@stem-player-web/core";

// The 3D Stem Player. Plain three.js held outside React's render cycle, the same
// way useAudioMixer holds the audio graph: React pushes state in, the scene calls
// back out, and nothing here re-renders the tree. It also only draws while
// something is moving, so an idle device costs no frames during playback.
//
// The canvas is one surface, so there is exactly one `gesture` at a time, and
// where it starts decides what it is. Starting on a groove, a drag sets that
// stem's level. Starting anywhere else, including on an edge button, a drag
// turns the device, which then stays exactly where it was released. Splitting
// that into separate handlers per part would let one drag both turn the device
// and change a volume. A double tap on the background, off the device, eases it
// back to the home pose.

type Arm = "N" | "E" | "S" | "W";
export const ARM_STEM: Record<Arm, StemName> = { N: "vocals", E: "drums", S: "instrumental", W: "bass" };
const ARMS = Object.keys(ARM_STEM) as Arm[];

export type ButtonName = "Btn_Center" | "Btn_Dots" | "Btn_Volume" | "Btn_Load";
const BUTTONS: ButtonName[] = ["Btn_Center", "Btn_Dots", "Btn_Volume", "Btn_Load"];
// Pills whose press can be held to keep going.
const HOLDABLE = new Set<ButtonName>(["Btn_Dots", "Btn_Volume"]);
const LEDS_PER_ARM = 4;

export type PillSide = "left" | "right";

const FOV = 26;
// Half the frame height, in metres, kept clear around the 70 mm body.
const FRAME_RADIUS = 0.048;

const TAP_SLOP_PX = 5;
const TURN_RAD_PER_PX = 0.009;
// How far along a groove counts as its outer end, where a hold solos the stem.
const SOLO_ZONE_START = 0.6;
const HOME_RETURN_RATE = 9;
const PRESS_DEPTH = 0.0008;
const PRESS_RATE = 26;
const LED_RATE = 18;

const Y_AXIS = new THREE.Vector3(0, 1, 0);

export interface DeviceActions {
  onTap(part: ButtonName, side: PillSide): void;
  onHoldStart(part: ButtonName, side: PillSide): void;
  onHoldEnd(part: ButtonName, side: PillSide): void;
  onGrooveMute(stem: StemName): void;
  onGrooveSolo(stem: StemName): void;
  onGrooveHoldStart(stem: StemName): void;
  onGrooveHoldEnd(stem: StemName): void;
  getStemVolume(stem: StemName): number;
  onGrooveDrag(stem: StemName, volume: number): void;
  onHover(part: ButtonName | StemName | null): void;
  onTurned(turned: boolean): void;
  // The GPU dropped the context. The scene is dead from here on.
  onContextLost(): void;
}

export interface DeviceScene {
  /** levels: stem -> { volume: 0..1, glow: 0..1 } */
  setLevels(levels: StemMap<{ volume: number; glow: number }>): void;
  /** Animate a press from the keyboard, where no gesture drives it. */
  pulse(name: ButtonName): void;
  dispose(): void;
}

type Part =
  | { kind: "groove"; stem: StemName }
  | { kind: "button"; name: ButtonName; outward: THREE.Vector3 };

interface Led {
  material: THREE.MeshBasicMaterial;
  target: number;
}

interface ArmState {
  mesh: THREE.Mesh;
  axis: THREE.Vector3;
  innerAlong: number;
  travel: number;
  leds: Led[];
  surfaceY: number;
}

interface Button {
  mesh: THREE.Mesh;
  name: ButtonName;
  rest: THREE.Vector3;
  outward: THREE.Vector3;
  depth: number;
  target: number;
}

interface Hit {
  part: Part;
  point: THREE.Vector3;
}

interface Gesture {
  id: number;
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  hit: Hit | null;
  button: Button | null;
  arm?: ArmState;
  stem?: StemName;
  startVolume?: number;
  startAlong?: number;
  side?: PillSide;
  holdTimer?: ReturnType<typeof setTimeout>;
  holding?: boolean;
}

/** Head-on: the top face square to the camera, with vocals at the top. */
function homePose() {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
}

// A hot core fading through the stem colour, the way these LEDs read through the
// silicone skin. `hex` has to be #rrggbb, since the fade appends alpha digits.
function ledTexture(hex: string) {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  if (!g) throw new Error("no 2D canvas for the LED texture");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(0.2, hex);
  grad.addColorStop(0.46, `${hex}4d`);
  grad.addColorStop(0.8, `${hex}00`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export async function createDeviceScene(
  canvas: HTMLCanvasElement,
  modelBytes: ArrayBuffer,
  stemColors: StemMap<string>,
  actions: DeviceActions,
): Promise<DeviceScene> {
  const stage = canvas.parentElement;
  if (!stage) throw new Error("the device canvas has to be in the page");

  // Everything that can fail on a bad model happens before the renderer
  // exists, so a failed build never leaves a WebGL context behind.
  const gltf = await new GLTFLoader().parseAsync(modelBytes, "");
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 2);
  const root = new THREE.Group();
  root.add(gltf.scene);
  scene.add(root);

  const HOME = homePose();
  root.quaternion.copy(HOME);

  function meshNamed(name: string) {
    const obj = gltf.scene.getObjectByName(name);
    if (!(obj instanceof THREE.Mesh)) throw new Error(`the device model has no ${name} mesh`);
    return obj;
  }

  // --- parts ---------------------------------------------------------------
  const textures: THREE.Texture[] = [];
  const leds: Led[] = [];
  const arms = {} as StemMap<ArmState>;
  for (const arm of ARMS) {
    const stem = ARM_STEM[arm];
    const map = ledTexture(stemColors[stem]);
    textures.push(map);

    const armLeds: Led[] = [];
    const positions: THREE.Vector3[] = [];
    for (let i = 1; i <= LEDS_PER_ARM; i++) {
      const mesh = meshNamed(`LED_${arm}_${i}`);
      const material = new THREE.MeshBasicMaterial({
        map,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        opacity: 0,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      mesh.material = material;
      mesh.renderOrder = 1;
      const led = { material, target: 0 };
      leds.push(led);
      armLeds.push(led);
      positions.push(mesh.position);
    }

    const inner = positions[0];
    const outer = positions[LEDS_PER_ARM - 1];
    const span = new THREE.Vector3().subVectors(outer, inner);
    span.y = 0;
    const pitch = span.length() / (LEDS_PER_ARM - 1);
    const hit = meshNamed(`Hit_${arm}`);
    // Raycast-only. Facing is decided by faces(), not by the strip's winding.
    hit.material = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
    hit.userData.part = { kind: "groove", stem } satisfies Part;
    arms[stem] = {
      mesh: hit,
      axis: span.normalize(),
      innerAlong: inner.dot(span),
      travel: pitch * LEDS_PER_ARM,
      leds: armLeds,
      surfaceY: (inner.y + outer.y) / 2,
    };
  }

  const buttons: Button[] = BUTTONS.map((name) => {
    const mesh = meshNamed(name);
    const rest = mesh.position.clone();
    const outward =
      name === "Btn_Center"
        ? Y_AXIS.clone()
        : new THREE.Vector3().fromArray(mesh.userData.press_dir as number[]).negate();
    mesh.userData.part = { kind: "button", name, outward } satisfies Part;
    return { mesh, name, rest, outward, depth: 0, target: 0 };
  });
  const buttonNamed = (name: ButtonName) => buttons.find((b) => b.name === name)!;
  const body = meshNamed("Body");
  const pickable = [...Object.values(arms).map((a) => a.mesh), ...buttons.map((b) => b.mesh)];

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = environment;
  scene.environmentIntensity = 0.32;
  pmrem.dispose();

  const key = new THREE.DirectionalLight(0xfff1e2, 1.25);
  key.position.set(-0.5, 0.9, 1);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xdfe8ff, 0.35);
  rim.position.set(0.9, -0.5, 0.2);
  scene.add(rim);

  let lost = false;
  const onContextLost = () => {
    lost = true;
    actions.onContextLost();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);

  // --- render loop ---------------------------------------------------------
  let raf = 0;
  let lastFrame = 0;
  let returningHome = false;
  let turned = false;

  function setTurned(next: boolean) {
    if (next === turned) return;
    turned = next;
    actions.onTurned(next);
  }

  const invalidate = () => {
    if (!raf && !lost) raf = requestAnimationFrame(frame);
  };

  function stepPose(dt: number) {
    if (!returningHome) return false;
    if (root.quaternion.angleTo(HOME) < 0.001) {
      root.quaternion.copy(HOME);
      returningHome = false;
      setTurned(false);
      return false;
    }
    root.quaternion.slerp(HOME, 1 - Math.exp(-dt * HOME_RETURN_RATE));
    return true;
  }

  function stepLeds(dt: number) {
    let busy = false;
    const ease = 1 - Math.exp(-dt * LED_RATE);
    for (const led of leds) {
      const m = led.material;
      const delta = led.target - m.opacity;
      if (Math.abs(delta) < 0.004) {
        m.opacity = led.target;
        continue;
      }
      m.opacity += delta * ease;
      busy = true;
    }
    return busy;
  }

  function stepButtons(dt: number) {
    let busy = false;
    const ease = 1 - Math.exp(-dt * PRESS_RATE);
    for (const b of buttons) {
      const delta = b.target - b.depth;
      if (Math.abs(delta) < 0.002) {
        if (b.depth !== b.target) b.depth = b.target;
      } else {
        b.depth += delta * ease;
        busy = true;
      }
      b.mesh.position.copy(b.rest).addScaledVector(b.outward, -b.depth * PRESS_DEPTH);
    }
    return busy;
  }

  function frame(now: number) {
    raf = 0;
    const dt = Math.min(0.05, lastFrame ? (now - lastFrame) / 1000 : 0.016);
    lastFrame = now;
    const a = stepPose(dt);
    const b = stepLeds(dt);
    const c = stepButtons(dt);
    renderer.render(scene, camera);
    if (a || b || c) invalidate();
    else lastFrame = 0;
  }

  function rotate(dx: number, dy: number) {
    const angle = Math.hypot(dx, dy);
    if (!angle) return;
    const axis = new THREE.Vector3(dy, dx, 0).normalize();
    root.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
  }

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = stage;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const fitWidth = Math.min(1, camera.aspect);
    camera.position.set(0, 0, FRAME_RADIUS / (halfHeight * fitWidth));
    camera.updateProjectionMatrix();
    invalidate();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);

  // --- picking -------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function setRay(e: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    root.updateMatrixWorld(true);
    raycaster.setFromCamera(ndc, camera);
  }

  // Which way a part faces the camera; a part on the far side of the body is
  // never a valid hit, even though the ray passes straight through to it.
  function faces(part: Part) {
    const normal = part.kind === "button" ? part.outward : Y_AXIS;
    const world = normal.clone().applyQuaternion(root.quaternion);
    return world.z > 0.12;
  }

  function pick(e: PointerEvent): Hit | null {
    setRay(e);
    for (const hit of raycaster.intersectObjects(pickable, false)) {
      const part = hit.object.userData.part as Part;
      if (faces(part)) return { part, point: hit.point };
    }
    return null;
  }

  function surfacePoint(e: PointerEvent, arm: ArmState) {
    setRay(e);
    const plane = new THREE.Plane(Y_AXIS.clone(), -arm.surfaceY);
    plane.applyMatrix4(root.matrixWorld);
    const out = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    return out ? root.worldToLocal(out) : null;
  }

  // Which end of an edge pill a hit landed on, as seen from outside the device.
  function pillSide(name: ButtonName, outward: THREE.Vector3, worldPoint: THREE.Vector3): PillSide {
    const local = root.worldToLocal(worldPoint.clone());
    const right = outward.clone().negate().cross(Y_AXIS);
    return local.sub(buttonNamed(name).rest).dot(right) > 0 ? "right" : "left";
  }

  function overBody(e: PointerEvent) {
    setRay(e);
    return raycaster.intersectObject(body, false).length > 0;
  }

  // --- gesture -------------------------------------------------------------
  let gesture: Gesture | null = null;
  // Click, double-click, hold and Option-click on grooves.
  const grooves = createGrooveGestures({
    onMute: (stem) => actions.onGrooveMute(stem),
    onSolo: (stem) => actions.onGrooveSolo(stem),
    onHoldStart: (stem) => actions.onGrooveHoldStart(stem),
    onHoldEnd: (stem) => actions.onGrooveHoldEnd(stem),
  });
  let lastBackgroundTap = -Infinity;

  function onBackgroundTap(e: PointerEvent) {
    if (overBody(e)) return;
    // Browsers don't expose the system double-click interval, so the background
    // uses the same default as the grooves.
    if (e.timeStamp - lastBackgroundTap < DEFAULT_DOUBLE_CLICK_MS) {
      lastBackgroundTap = -Infinity;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        root.quaternion.copy(HOME);
        setTurned(false);
      } else {
        returningHome = true;
      }
      invalidate();
    } else {
      lastBackgroundTap = e.timeStamp;
    }
  }

  function endGesture(g: Gesture) {
    clearTimeout(g.holdTimer);
    if (g.button) g.button.target = 0;
    // A cancelled pointer has already lost its capture, and releasing it again throws.
    if (canvas.hasPointerCapture(g.id)) canvas.releasePointerCapture(g.id);
    gesture = null;
    invalidate();
  }

  function onDown(e: PointerEvent) {
    if (gesture || e.button !== 0) return;
    const hit = pick(e);
    const g: Gesture = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false,
      hit,
      button: null,
    };
    gesture = g;
    canvas.setPointerCapture(e.pointerId);

    const part = hit?.part;
    if (hit && part?.kind === "button") {
      g.button = buttonNamed(part.name);
      g.button.target = 1;
      invalidate();
      // A pill press that outlasts HOLD_MS without moving is a hold, not a
      // click: it keeps going until release instead of firing onTap.
      if (HOLDABLE.has(part.name)) {
        const side = pillSide(part.name, part.outward, hit.point);
        g.side = side;
        g.holdTimer = setTimeout(() => {
          if (gesture !== g || g.moved) return;
          g.holding = true;
          actions.onHoldStart(part.name, side);
        }, HOLD_MS);
      }
    }
    if (part?.kind === "groove") {
      const arm = arms[part.stem];
      g.arm = arm;
      g.stem = part.stem;
      g.startVolume = actions.getStemVolume(part.stem);
      const start = surfacePoint(e, arm);
      g.startAlong = start ? start.dot(arm.axis) : 0;
      const alongArm = (g.startAlong - arm.innerAlong) / arm.travel;
      grooves.down(part.stem, { alt: e.altKey, atEnd: alongArm >= SOLO_ZONE_START });
    }
  }

  function onMove(e: PointerEvent) {
    if (!gesture) {
      const part = pick(e)?.part;
      const name = part ? (part.kind === "button" ? part.name : part.stem) : null;
      actions.onHover(name);
      canvas.dataset.part = name ?? "";
      return;
    }
    const g = gesture;
    if (e.pointerId !== g.id) return;
    // A held pill stays held through a wobble; it never turns the device.
    if (g.holding) return;

    if (!g.moved) {
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < TAP_SLOP_PX) return;
      g.moved = true;
      clearTimeout(g.holdTimer);
      if (g.arm) grooves.drag();
      if (g.button) {
        g.button.target = 0;
        invalidate();
      }
    }

    if (!g.arm) {
      returningHome = false;
      setTurned(true);
      rotate((e.clientX - g.lastX) * TURN_RAD_PER_PX, (e.clientY - g.lastY) * TURN_RAD_PER_PX);
      invalidate();
    } else if (grooves.isDragging()) {
      const point = surfacePoint(e, g.arm);
      if (point) {
        const along = point.dot(g.arm.axis) - g.startAlong!;
        actions.onGrooveDrag(g.stem!, g.startVolume! + along / g.arm.travel);
      }
    }
    g.lastX = e.clientX;
    g.lastY = e.clientY;
  }

  function onUp(e: PointerEvent) {
    const g = gesture;
    if (!g || e.pointerId !== g.id) return;
    endGesture(g);
    if (g.arm) {
      grooves.up();
      return;
    }
    const { hit } = g;
    if (g.holding && hit?.part.kind === "button") {
      actions.onHoldEnd(hit.part.name, g.side!);
      return;
    }
    if (g.moved) return;
    if (!hit) onBackgroundTap(e);
    else if (hit.part.kind === "button") {
      actions.onTap(hit.part.name, pillSide(hit.part.name, hit.part.outward, hit.point));
    }
  }

  function onCancel(e: PointerEvent) {
    const g = gesture;
    if (!g || e.pointerId !== g.id) return;
    if (g.arm) grooves.cancel();
    endGesture(g);
    const part = g.hit?.part;
    if (g.holding && part?.kind === "button") actions.onHoldEnd(part.name, g.side!);
  }

  function onLeave() {
    if (!gesture) actions.onHover(null);
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("pointerleave", onLeave);

  resize();

  return {
    setLevels(levels) {
      for (const [stem, { volume, glow }] of Object.entries(levels) as [StemName, { volume: number; glow: number }][]) {
        arms[stem].leds.forEach((led, i) => {
          const fill = Math.min(1, Math.max(0, volume * LEDS_PER_ARM - i));
          led.target = fill * glow;
        });
      }
      invalidate();
    },

    pulse(name) {
      const b = buttonNamed(name);
      b.target = 1;
      invalidate();
      setTimeout(() => {
        b.target = 0;
        invalidate();
      }, 110);
    },

    dispose() {
      cancelAnimationFrame(raf);
      if (gesture) clearTimeout(gesture.holdTimer);
      grooves.dispose();
      resizeObserver.disconnect();
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onLeave);
      scene.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        obj.geometry.dispose();
        const materials: THREE.Material[] = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of materials) {
          if (m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshBasicMaterial) m.map?.dispose();
          m.dispose();
        }
      });
      for (const t of textures) t.dispose();
      environment.dispose();
      renderer.dispose();
    },
  };
}
