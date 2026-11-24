import { AGENT_IDS, AGENT_PROFILES, type AgentId, type AgentVisualState, type TaskView } from '@nexus/shared';
import gsap from 'gsap';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export const STATE_META: Record<AgentVisualState, { label: string; color: string }> = {
  idle: { label: 'Idle', color: '#7f8bb8' },
  thinking: { label: 'Thinking', color: '#9b8cff' },
  working: { label: 'Working', color: '#2fd8ff' },
  browsing: { label: 'Browsing', color: '#45f0c4' },
  waiting: { label: 'Needs approval', color: '#ffbe5c' },
  done: { label: 'Completed', color: '#45f0a0' },
  error: { label: 'Error', color: '#ff5470' },
  offline: { label: 'Setup needed', color: '#ffbe5c' },
};

interface StationLayout {
  id: AgentId;
  pos: [number, number, number];
  rot: number;
  seated: boolean;
}

const LAYOUT: StationLayout[] = [
  { id: 'atlas', pos: [0, 0, -0.35], rot: 0, seated: false },
  { id: 'forge', pos: [-5.7, 0, 2.1], rot: 0.32, seated: true },
  { id: 'scout', pos: [5.7, 0, 2.1], rot: -0.32, seated: true },
  { id: 'pulse', pos: [-4.4, 0, -4.5], rot: 0.18, seated: true },
  { id: 'ledger', pos: [4.4, 0, -4.5], rot: -0.18, seated: true },
];

const SW = 640;
const SH = 400;
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';
const BODY = 'Manrope, system-ui, sans-serif';
const DISP = 'Unbounded, Manrope, system-ui, sans-serif';

interface RobotRig {
  group: THREE.Group;
  body: THREE.Group;
  torso: THREE.Mesh;
  head: THREE.Group;
  eyes: THREE.Mesh[];
  L: { sh: THREE.Group; el: THREE.Group };
  R: { sh: THREE.Group; el: THREE.Group };
  thought: THREE.Group;
  thoughtCore: THREE.Mesh;
  orbs: THREE.Mesh[];
  halo?: THREE.Mesh;
  hoverRing?: THREE.Mesh;
  beacon?: THREE.Mesh;
  drone?: THREE.Group;
  waves?: THREE.Mesh[];
}

interface AgentNode {
  id: AgentId;
  layout: StationLayout;
  state: AgentVisualState;
  label: string | null;
  detail: string | null;
  lines: string[];
  browserImg: HTMLImageElement | null;
  browserUrl: string;
  approvalSummary: string;
  waving: boolean;
  cv: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex?: THREE.CanvasTexture;
  st?: THREE.Group;
  R?: RobotRig;
  chair?: THREE.Group;
  ring?: THREE.Mesh;
  light?: THREE.PointLight;
  keys?: THREE.Mesh;
  side?: THREE.Mesh;
  tag?: { c: HTMLCanvasElement; tex: THREE.CanvasTexture; sp: THREE.Sprite };
  tagY: number;
  anchor: THREE.Vector3;
}

export interface OfficeEngineOptions {
  canvas: HTMLCanvasElement;
  container: HTMLElement;
  onSelectAgent?: (id: AgentId) => void;
  onPerf?: (text: string) => void;
  onWebGLFailed?: () => void;
}

function rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function lineColor(l: string): string {
  if (l.startsWith('$')) return '#2fd8ff';
  if (l.includes('✓') || l.includes('pass ')) return '#45f0a0';
  if (l.includes('✗') || l.includes('fail ') || l.startsWith('ERROR')) return '#ff5470';
  if (l.startsWith('  ')) return '#8a95bd';
  return '#d6ddff';
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/**
 * Typed Three.js 3D Office Engine ported from docs/design/nexus-office-prototype.html.
 * Driven strictly by real backend events and snapshots — never scripts fake activity.
 */
export class OfficeEngine {
  private opts: OfficeEngineOptions;
  private reduceMotion: boolean;
  private lowPower: boolean;
  private agents: Record<AgentId, AgentNode>;
  private tasks: TaskView[] = [];
  private selectedId: AgentId = 'atlas';
  private mirrorCanvas: HTMLCanvasElement | null = null;

  private has3D = false;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private controls: OrbitControls | null = null;
  private clock3: THREE.Clock | null = null;
  private dirLight: THREE.DirectionalLight | null = null;
  private gridMat: THREE.ShaderMaterial | null = null;
  private dust: THREE.Points | null = null;
  private softDotTex: THREE.CanvasTexture | null = null;
  private holo: {
    rings: THREE.Mesh[];
    core: THREE.Mesh | null;
    racks: { rc: HTMLCanvasElement; tex: THREE.CanvasTexture }[];
  } = { rings: [], core: null, racks: [] };

  private homePos = new THREE.Vector3(0, 16.5, 17.8);
  private homeBase = new THREE.Vector3(0, 16.5, 17.8);
  private homeTarget = new THREE.Vector3(0, 0.6, -1.0);
  private pickables: THREE.Object3D[] = [];
  private bursts: { pts: THREE.Points; vel: THREE.Vector3[]; life: number }[] = [];
  private tmpColor = new THREE.Color();

  private rafId = 0;
  private disposed = false;
  private visible = true;
  private frames = 0;
  private fpsT = 0;
  private fpsAcc = 0;
  private lowered = false;
  private screenT = 0;
  private resizeObs: ResizeObserver | null = null;
  private interObs: IntersectionObserver | null = null;
  private cleanupListeners: (() => void)[] = [];

  constructor(opts: OfficeEngineOptions) {
    this.opts = opts;
    this.reduceMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.lowPower = typeof window !== 'undefined' && window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;

    const map = {} as Record<AgentId, AgentNode>;
    for (const layout of LAYOUT) {
      const cv = document.createElement('canvas');
      cv.width = SW;
      cv.height = SH;
      const ctx = cv.getContext('2d')!;
      map[layout.id] = {
        id: layout.id,
        layout,
        state: 'idle',
        label: null,
        detail: null,
        lines: [],
        browserImg: null,
        browserUrl: '',
        approvalSummary: '',
        waving: false,
        cv,
        ctx,
        tagY: layout.seated ? 2.75 : 4.5,
        anchor: new THREE.Vector3(0, layout.seated ? 2.35 : 2.6, layout.seated ? 0.98 : 0),
      };
    }
    this.agents = map;

    this.init3D();
    this.loop();
  }

  /* ---------------- Public event-driven API ---------------- */

  setSelectedAgent(id: AgentId) {
    this.selectedId = id;
  }

  setMirrorCanvas(canvas: HTMLCanvasElement | null) {
    this.mirrorCanvas = canvas;
  }

  setAgentState(id: AgentId, state: AgentVisualState, opts: { label?: string | null; detail?: string | null; celebrate?: boolean } = {}) {
    const a = this.agents[id];
    if (!a) return;
    const prev = a.state;
    a.state = state;
    a.label = opts.label ?? null;
    a.detail = opts.detail ?? null;
    this.drawTag(a);
    if (opts.celebrate || (state === 'done' && prev !== 'done')) {
      this.celebrate(id);
    }
  }

  setApprovalSummary(id: AgentId, summary: string) {
    const a = this.agents[id];
    if (a) a.approvalSummary = summary;
  }

  appendLine(id: AgentId, text: string) {
    const a = this.agents[id];
    if (!a) return;
    for (const line of text.replace(/\r/g, '').split('\n')) {
      if (!line && a.lines[a.lines.length - 1] === '') continue;
      a.lines.push(line);
      if (a.lines.length > 100) a.lines.shift();
    }
  }

  setLines(id: AgentId, lines: string[]) {
    const a = this.agents[id];
    if (!a) return;
    a.lines = lines.slice(-100);
  }

  setBrowserFrame(id: AgentId, base64Jpeg: string, url: string) {
    const a = this.agents[id];
    if (!a) return;
    a.browserUrl = url;
    const img = new Image();
    img.onload = () => {
      a.browserImg = img;
    };
    img.src = `data:image/jpeg;base64,${base64Jpeg}`;
  }

  setTasks(tasks: TaskView[]) {
    this.tasks = tasks;
  }

  sendLink(from: AgentId, to: AgentId) {
    if (!this.has3D || !this.scene || !this.softDotTex) return;
    if (!this.agents[from]?.st || !this.agents[to]?.st) return;
    const p0 = this.anchorWorld(from);
    const p2 = this.anchorWorld(to);
    const mid = p0.clone().lerp(p2, 0.5);
    mid.y += 2.2 + p0.distanceTo(p2) * 0.12;
    const curve = new THREE.QuadraticBezierCurve3(p0, mid, p2);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uA: { value: new THREE.Color(AGENT_PROFILES[from].color) },
        uB: { value: new THREE.Color(AGENT_PROFILES[to].color) },
        uP: { value: 0 },
        uF: { value: 1 },
      },
      vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader:
        'uniform vec3 uA;uniform vec3 uB;uniform float uP;uniform float uF;varying vec2 vUv;void main(){float x=vUv.x;float head=smoothstep(uP-.28,uP,x)*step(x,uP);float body=step(x,uP)*.35;vec3 c=mix(uA,uB,x);gl_FragColor=vec4(c*(1.+head*1.5),(body+head)*uF);}',
    });
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 72, 0.028, 6, false), mat);
    this.scene.add(tube);
    const pk = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }));
    this.scene.add(pk);
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.softDotTex, color: AGENT_PROFILES[from].color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    halo.scale.set(0.8, 0.8, 1);
    pk.add(halo);
    const u = mat.uniforms;
    const dur = this.reduceMotion ? 0.3 : 1.25;
    gsap.to(u.uP, {
      value: 1.02,
      duration: dur,
      ease: 'power2.inOut',
      onUpdate: () => {
        pk.position.copy(curve.getPoint(Math.min(u.uP.value, 1)));
      },
      onComplete: () => {
        this.scene?.remove(pk);
        this.flashRing(to);
        gsap.to(u.uF, {
          value: 0,
          duration: 1.4,
          delay: 0.5,
          onComplete: () => {
            this.scene?.remove(tube);
            tube.geometry.dispose();
            mat.dispose();
          },
        });
      },
    });
  }

  celebrate(id: AgentId) {
    const a = this.agents[id];
    if (!a || !this.has3D) return;
    this.burst(id);
    if (this.reduceMotion) return;
    if (a.chair) {
      a.waving = true;
      gsap
        .timeline()
        .to(a.chair.rotation, { y: Math.PI, duration: 0.8, ease: 'power2.inOut' })
        .to(a.chair.rotation, { y: 0, duration: 0.9, ease: 'power2.inOut', delay: 1.8, onStart: () => { a.waving = false; } });
    } else if (a.R) {
      a.waving = true;
      gsap
        .timeline()
        .to(a.R.group.rotation, { y: Math.PI * 2, duration: 1.2, ease: 'power2.inOut' })
        .set(a.R.group.rotation, { y: 0 })
        .call(() => { a.waving = false; }, undefined, '+=1.2');
      gsap.to(a.R.group.position, { y: 0.5, duration: 0.5, yoyo: true, repeat: 1, ease: 'power2.out' });
    }
  }

  focusAgent(id: AgentId) {
    if (!this.has3D || !this.agents[id]?.st) return;
    const a = this.agents[id];
    const target = a.st!.localToWorld(new THREE.Vector3(0, 1.4, a.layout.seated ? 0.2 : 0));
    const off = new THREE.Vector3(a.layout.seated ? 1.4 : 0, 3.2, a.layout.seated ? 5.6 : 6.5).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      a.layout.rot,
    );
    this.flyTo(target.clone().add(off), target);
  }

  resetOverview() {
    this.flyTo(this.homePos, this.homeTarget);
  }

  refreshFonts() {
    for (const id of AGENT_IDS) this.drawTag(this.agents[id]);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.resizeObs?.disconnect();
    this.interObs?.disconnect();
    for (const fn of this.cleanupListeners) fn();
    this.controls?.dispose();
    this.renderer?.dispose();
  }

  /* ---------------- 3D Initialization ---------------- */

  private M(color: string, o?: THREE.MeshStandardMaterialParameters) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.2, ...o });
  }

  private G(color: string, intensity = 1.6) {
    return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.4, metalness: 0 });
  }

  private addMesh(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    parent: THREE.Object3D,
    shadow = true,
  ) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (shadow) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    parent.add(m);
    return m;
  }

  private makeSoftDot(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d')!;
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  private init3D() {
    const { canvas, container } = this.opts;
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !this.lowPower, powerPreference: 'high-performance' });
      this.has3D = true;
    } catch {
      this.has3D = false;
      this.opts.onWebGLFailed?.();
      return;
    }

    const r = this.renderer;
    r.setPixelRatio(this.lowPower ? Math.min(window.devicePixelRatio, 1.25) : Math.min(window.devicePixelRatio, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.15;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#060913');
    scene.fog = new THREE.Fog('#060913', 28, 52);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
    camera.position.copy(this.homePos);
    this.camera = camera;

    const controls = new OrbitControls(camera, canvas);
    controls.target.copy(this.homeTarget);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 6;
    controls.maxDistance = 40;
    controls.maxPolarAngle = 1.32;
    controls.minPolarAngle = 0.3;
    controls.screenSpacePanning = false;
    controls.rotateSpeed = 0.6;
    this.controls = controls;
    this.clock3 = new THREE.Clock();
    this.softDotTex = this.makeSoftDot();

    // Lighting
    scene.add(new THREE.HemisphereLight('#7088ff', '#05070f', 0.55));
    const dirLight = new THREE.DirectionalLight('#d4dcff', 1.05);
    dirLight.position.set(7, 16, 10);
    dirLight.castShadow = true;
    const sm = this.lowPower ? 1024 : 2048;
    dirLight.shadow.mapSize.set(sm, sm);
    Object.assign(dirLight.shadow.camera, { left: -14, right: 14, top: 12, bottom: -12, near: 1, far: 40 });
    dirLight.shadow.bias = -0.0006;
    dirLight.shadow.radius = 4;
    scene.add(dirLight);
    this.dirLight = dirLight;

    const rim = new THREE.DirectionalLight('#9b8cff', 0.55);
    rim.position.set(-10, 7, -12);
    scene.add(rim);
    const fill = new THREE.PointLight('#2fd8ff', 0.8, 16, 2);
    fill.position.set(0, 3.2, 2);
    scene.add(fill);

    // Floor + platform
    const floor = this.addMesh(new THREE.PlaneGeometry(120, 120), this.M('#070b18', { roughness: 0.7, metalness: 0.3 }), 0, 0, 0, scene, false);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    const plat = this.addMesh(new THREE.BoxGeometry(24, 0.14, 16.5), this.M('#0c1329', { roughness: 0.42, metalness: 0.55 }), 0, 0.07, -1.1, scene, false);
    plat.receiveShadow = true;
    const edgeMat = this.G('#4d7cff', 1.4);
    [
      [24, 0.04, 0.06, 0, 0.12, 7.15],
      [24, 0.04, 0.06, 0, 0.12, -9.35],
      [0.06, 0.04, 16.5, 12, 0.12, -1.1],
      [0.06, 0.04, 16.5, -12, 0.12, -1.1],
    ].forEach(([w, h, d, x, y, z]) => this.addMesh(new THREE.BoxGeometry(w, h, d), edgeMat, x, y, z, scene, false));

    this.gridMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color('#3f6cff') } },
      vertexShader: 'varying vec3 vW;void main(){vec4 w=modelMatrix*vec4(position,1.);vW=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}',
      fragmentShader:
        'uniform float uTime;uniform vec3 uColor;varying vec3 vW;void main(){vec2 p=vW.xz*0.8;vec2 g=abs(fract(p-.5)-.5)/fwidth(p);float line=1.-min(min(g.x,g.y),1.);float d=length(vW.xz-vec2(0.,1.6));float r=mod(uTime*2.6,16.);float ring=exp(-pow((d-r)*1.8,2.))*(1.-r/16.);float fade=smoothstep(13.,3.,d);gl_FragColor=vec4(uColor,(line*(.13+ring*1.1)+ring*.05)*fade);}',
    });
    const grid = new THREE.Mesh(new THREE.PlaneGeometry(24, 16.5), this.gridMat);
    grid.rotation.x = -Math.PI / 2;
    grid.position.set(0, 0.145, -1.1);
    scene.add(grid);

    // Back wall + light strips + NEXUS wordmark
    const wallMat = this.M('#0d152e', { roughness: 0.3, metalness: 0.6, transparent: true, opacity: 0.8 });
    this.addMesh(new THREE.BoxGeometry(24, 3.2, 0.12), wallMat, 0, 1.74, -9.3, scene, false);
    const stripMat = this.G('#2fd8ff', 1.2);
    const stripMat2 = this.G('#9b8cff', 1.2);
    for (let i = -5; i <= 5; i++) {
      this.addMesh(new THREE.BoxGeometry(0.05, 2.4, 0.04), i % 2 ? stripMat : stripMat2, i * 2.1, 1.7, -9.22, scene, false);
    }
    const wc = document.createElement('canvas');
    wc.width = 1024;
    wc.height = 128;
    const wx = wc.getContext('2d')!;
    wx.fillStyle = '#000';
    wx.fillRect(0, 0, 1024, 128);
    wx.font = `700 78px ${DISP}`;
    wx.textAlign = 'center';
    wx.textBaseline = 'middle';
    const wg = wx.createLinearGradient(300, 0, 724, 0);
    wg.addColorStop(0, '#2fd8ff');
    wg.addColorStop(1, '#9b8cff');
    wx.fillStyle = wg;
    wx.fillText('N E X U S', 512, 68);
    const word = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 0.75),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(wc), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, opacity: 0.85 }),
    );
    word.position.set(0, 2.75, -9.2);
    scene.add(word);

    // Server racks
    [-10.3, 10.3].forEach((x) => {
      this.addMesh(new THREE.BoxGeometry(1.3, 2.7, 1), this.M('#0b1124', { metalness: 0.7, roughness: 0.3 }), x, 1.49, -7.7, scene);
      const rc = document.createElement('canvas');
      rc.width = 64;
      rc.height = 128;
      const tex = new THREE.CanvasTexture(rc);
      const p = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 2.4), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      p.position.set(x, 1.49, -7.19);
      scene.add(p);
      this.holo.racks.push({ rc, tex });
    });

    // Plants
    const leaf = this.M('#1f9c8a', { roughness: 0.6, flatShading: true });
    const pot = this.M('#1a2342', { metalness: 0.5, roughness: 0.3 });
    [
      [-10.6, 0, 4.6],
      [10.6, 0, 4.6],
      [-10.6, 0, -2],
    ].forEach(([x, , z]) => {
      this.addMesh(new THREE.CylinderGeometry(0.38, 0.3, 0.6, 20), pot, x, 0.44, z, scene);
      for (let i = 0; i < 5; i++) {
        const l = this.addMesh(
          new THREE.IcosahedronGeometry(0.32, 0),
          leaf,
          x + Math.cos(i * 1.3) * 0.22,
          1.0 + i * 0.17,
          z + Math.sin(i * 1.3) * 0.22,
          scene,
        );
        l.scale.set(0.7, 1.6, 0.7);
        l.rotation.set(Math.cos(i) * 0.5, i, Math.sin(i) * 0.5);
      }
    });

    // Central holo table
    const tz = 1.75;
    this.addMesh(new THREE.CylinderGeometry(1.0, 1.2, 0.75, 48), this.M('#0f1733', { metalness: 0.75, roughness: 0.25 }), 0, 0.52, tz, scene);
    this.addMesh(new THREE.CylinderGeometry(1.02, 1.02, 0.04, 48), this.G('#1d8fd0', 0.7), 0, 0.91, tz, scene, false);
    const beamMat = new THREE.MeshBasicMaterial({
      color: '#2fd8ff',
      transparent: true,
      opacity: 0.04,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.addMesh(new THREE.CylinderGeometry(0.95, 0.8, 1.3, 48, 1, true), beamMat, 0, 1.58, tz, scene, false);
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.55 + i * 0.18, 0.012, 8, 80),
        new THREE.MeshBasicMaterial({ color: i === 1 ? '#9b8cff' : '#2fd8ff', transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, toneMapped: false }),
      );
      ring.position.set(0, 1.25 + i * 0.22, tz);
      ring.rotation.x = Math.PI / 2;
      scene.add(ring);
      this.holo.rings.push(ring);
    }
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.32, 1),
      new THREE.MeshBasicMaterial({ color: '#8fe9ff', wireframe: true, transparent: true, opacity: 0.9, toneMapped: false }),
    );
    core.position.set(0, 1.6, tz);
    scene.add(core);
    this.holo.core = core;

    // Ambient dust
    const N = this.lowPower ? 220 : 520;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 26;
      pos[i * 3 + 1] = Math.random() * 7;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 18 - 1;
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(
      dg,
      new THREE.PointsMaterial({ size: 0.07, map: this.softDotTex, color: '#8fb7ff', transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    scene.add(this.dust);

    for (const id of AGENT_IDS) this.buildStation(this.agents[id]);

    this.resize();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.interObs = new IntersectionObserver((es) => {
      this.visible = es[0]?.isIntersecting ?? true;
    });
    this.interObs.observe(container);
    this.setupPicking(canvas);
  }

  private makeRobot(a: AgentNode): RobotRig {
    const profile = AGENT_PROFILES[a.id];
    const shell = this.M('#e7ecf7', { roughness: 0.28, metalness: 0.12 });
    const dark = this.M('#10172e', { roughness: 0.22, metalness: 0.75 });
    const glow = this.G(profile.color, 1.7);

    const g = new THREE.Group();
    const body = new THREE.Group();
    g.add(body);
    const lift = a.layout.seated ? 0 : 0.32;
    body.position.y = lift;

    const torso = this.addMesh(new THREE.SphereGeometry(0.42, 32, 24), shell, 0, 1.02, 0, body);
    torso.scale.set(1, 1.12, 0.86);
    const belt = this.addMesh(new THREE.TorusGeometry(0.385, 0.032, 10, 48), glow, 0, 0.84, 0, body);
    belt.rotation.x = Math.PI / 2;
    this.addMesh(new THREE.CircleGeometry(0.085, 24), glow, 0, 1.13, 0.372, body);
    this.addMesh(new THREE.BoxGeometry(0.34, 0.42, 0.08), dark, 0, 1.06, -0.33, body);
    this.addMesh(new THREE.BoxGeometry(0.05, 0.3, 0.02), glow, 0, 1.06, -0.375, body, false);
    const hip = this.addMesh(new THREE.SphereGeometry(0.26, 24, 16), dark, 0, 0.66, 0, body);
    hip.scale.set(1.2, 0.6, 1);
    this.addMesh(new THREE.CylinderGeometry(0.07, 0.08, 0.16, 16), dark, 0, 1.52, 0, body);

    const head = new THREE.Group();
    head.position.y = 1.68;
    body.add(head);
    const eyes: THREE.Mesh[] = [];

    if (a.id === 'ledger') {
      this.addMesh(new THREE.BoxGeometry(0.7, 0.52, 0.58), shell, 0, 0, 0, head);
      this.addMesh(new THREE.BoxGeometry(0.6, 0.26, 0.04), dark, 0, 0, 0.29, head);
      eyes.push(this.addMesh(new THREE.BoxGeometry(0.42, 0.05, 0.02), glow, 0, 0, 0.315, head, false));
      [-1, 1].forEach((s) => {
        const e = this.addMesh(new THREE.CylinderGeometry(0.09, 0.09, 0.05, 20), glow, s * 0.37, 0, 0, head, false);
        e.rotation.z = Math.PI / 2;
      });
      this.addMesh(new THREE.BoxGeometry(0.5, 0.04, 0.4), dark, 0, 0.28, 0, head);
    } else {
      const hs = this.addMesh(new THREE.SphereGeometry(0.34, 32, 24), shell, 0, 0, 0, head);
      hs.scale.set(1.18, 0.94, 1.02);
      const vis = this.addMesh(new THREE.SphereGeometry(0.3, 32, 16), dark, 0, -0.01, 0.13, head);
      vis.scale.set(1.12, 0.64, 0.62);
      [-1, 1].forEach((s) => {
        const e = this.addMesh(new THREE.SphereGeometry(0.048, 16, 12), glow, s * 0.11, 0, 0.31, head, false);
        e.scale.set(1.3, 1, 0.5);
        eyes.push(e);
        const ear = this.addMesh(new THREE.CylinderGeometry(0.095, 0.095, 0.06, 20), glow, s * 0.4, 0, 0, head, false);
        ear.rotation.z = Math.PI / 2;
      });
    }

    const rig: RobotRig = {
      group: g,
      body,
      torso,
      head,
      eyes,
      L: { sh: new THREE.Group(), el: new THREE.Group() },
      R: { sh: new THREE.Group(), el: new THREE.Group() },
      thought: new THREE.Group(),
      thoughtCore: new THREE.Mesh(),
      orbs: [],
    };

    // Role-specific accessories matching approved design
    if (a.id === 'atlas') {
      rig.halo = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.022, 10, 48), this.G(profile.color, 2.4));
      rig.halo.position.y = 0.5;
      rig.halo.rotation.x = Math.PI / 2;
      head.add(rig.halo);
      [-1, 1].forEach((s) => {
        const p = this.addMesh(new THREE.SphereGeometry(0.17, 20, 14), this.M('#c9c2ff', { metalness: 0.4, roughness: 0.3 }), s * 0.46, 1.32, 0, body);
        p.scale.set(1, 0.6, 1);
      });
      const thr = this.addMesh(new THREE.ConeGeometry(0.2, 0.4, 24), glow, 0, 0.32, 0, body, false);
      thr.rotation.x = Math.PI;
      rig.hoverRing = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.03, 10, 48), this.G(profile.color, 2));
      rig.hoverRing.rotation.x = Math.PI / 2;
      rig.hoverRing.position.y = 0.2;
      g.add(rig.hoverRing);
    }
    if (a.id === 'forge') {
      this.addMesh(new THREE.TorusGeometry(0.42, 0.035, 10, 32, Math.PI), dark, 0, 0, 0, head);
      [-1, 1].forEach((s) => {
        const cup = this.addMesh(new THREE.CylinderGeometry(0.15, 0.15, 0.12, 24), dark, s * 0.42, 0, 0, head);
        cup.rotation.z = Math.PI / 2;
        const rimRing = this.addMesh(new THREE.TorusGeometry(0.13, 0.018, 8, 24), glow, s * 0.485, 0, 0, head, false);
        rimRing.rotation.y = Math.PI / 2;
      });
    }
    if (a.id === 'scout') {
      this.addMesh(new THREE.CylinderGeometry(0.015, 0.015, 0.45, 8), dark, 0.12, 0.48, 0, head);
      rig.beacon = this.addMesh(new THREE.SphereGeometry(0.06, 16, 12), this.G(profile.color, 3), 0.12, 0.72, 0, head, false);
      rig.drone = new THREE.Group();
      g.add(rig.drone);
      this.addMesh(new THREE.SphereGeometry(0.09, 16, 12), shell, 0, 0, 0, rig.drone);
      const dr = this.addMesh(new THREE.TorusGeometry(0.13, 0.015, 8, 24), glow, 0, 0, 0, rig.drone, false);
      dr.rotation.x = Math.PI / 2;
    }
    if (a.id === 'pulse') {
      const fin = this.addMesh(new THREE.BoxGeometry(0.06, 0.24, 0.46), this.G(profile.color, 1.2), 0, 0.34, -0.02, head);
      fin.rotation.x = -0.2;
      rig.waves = [];
      for (let i = 0; i < 2; i++) {
        const w = new THREE.Mesh(
          new THREE.TorusGeometry(0.4, 0.012, 8, 48),
          new THREE.MeshBasicMaterial({ color: profile.color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, toneMapped: false }),
        );
        w.rotation.x = Math.PI / 2;
        w.position.y = 1.05;
        body.add(w);
        rig.waves.push(w);
      }
    }

    const makeArm = (side: number) => {
      const sh = new THREE.Group();
      sh.position.set(side * 0.47, 1.26, 0);
      body.add(sh);
      this.addMesh(new THREE.SphereGeometry(0.1, 16, 12), dark, 0, 0, 0, sh);
      this.addMesh(new THREE.CylinderGeometry(0.075, 0.068, 0.34, 14), shell, 0, -0.19, 0, sh);
      const el = new THREE.Group();
      el.position.y = -0.36;
      sh.add(el);
      this.addMesh(new THREE.CylinderGeometry(0.068, 0.058, 0.28, 14), shell, 0, -0.15, 0, el);
      const cuff = this.addMesh(new THREE.TorusGeometry(0.065, 0.016, 8, 20), glow, 0, -0.22, 0, el, false);
      cuff.rotation.x = Math.PI / 2;
      this.addMesh(new THREE.SphereGeometry(0.085, 16, 12), dark, 0, -0.32, 0, el);
      return { sh, el };
    };
    rig.L = makeArm(-1);
    rig.R = makeArm(1);

    if (a.layout.seated) {
      [-1, 1].forEach((s) => {
        const th = this.addMesh(new THREE.CylinderGeometry(0.09, 0.085, 0.42, 14), dark, s * 0.17, 0.6, 0.2, body);
        th.rotation.x = Math.PI / 2;
        this.addMesh(new THREE.CylinderGeometry(0.08, 0.075, 0.48, 14), dark, s * 0.17, 0.34, 0.42, body);
        this.addMesh(new THREE.BoxGeometry(0.16, 0.08, 0.26), shell, s * 0.17, 0.08, 0.48, body);
      });
    }

    // Thought wireframe glyph
    rig.thought.position.set(0, 2.42 + lift, 0);
    g.add(rig.thought);
    rig.thought.scale.setScalar(0.001);
    rig.thoughtCore = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.16, 0),
      new THREE.MeshBasicMaterial({ color: '#b9adff', wireframe: true, toneMapped: false }),
    );
    rig.thought.add(rig.thoughtCore);
    rig.orbs = [0, 1, 2].map(() => {
      const o = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshBasicMaterial({ color: '#e2dcff', toneMapped: false }));
      rig.thought.add(o);
      return o;
    });

    g.traverse((o) => {
      o.userData.agent = a.id;
    });
    return rig;
  }

  private buildStation(a: AgentNode) {
    if (!this.scene) return;
    const profile = AGENT_PROFILES[a.id];
    const st = new THREE.Group();
    st.position.set(...a.layout.pos);
    st.rotation.y = a.layout.rot;
    this.scene.add(st);
    a.st = st;

    const tex = new THREE.CanvasTexture(a.cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    a.tex = tex;

    const R = this.makeRobot(a);
    a.R = R;

    const ringMat = new THREE.MeshBasicMaterial({
      color: profile.color,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    a.light = new THREE.PointLight(profile.color, 0.9, 4.5, 2);

    if (a.layout.seated) {
      const deskMat = this.M('#141d38', { roughness: 0.32, metalness: 0.6 });
      const dark = this.M('#0b1022', { roughness: 0.3, metalness: 0.7 });
      this.addMesh(new THREE.BoxGeometry(2.6, 0.07, 1.15), deskMat, 0, 0.78, 0, st);
      [-1, 1].forEach((s) => this.addMesh(new THREE.BoxGeometry(0.06, 0.74, 1.0), deskMat, s * 1.22, 0.39, 0, st));
      this.addMesh(new THREE.BoxGeometry(2.6, 0.026, 0.026), this.G(profile.color, 1.8), 0, 0.75, 0.585, st, false);
      this.addMesh(new THREE.BoxGeometry(1.66, 1.02, 0.06), dark, 0, 1.42, -0.32, st);
      this.addMesh(new THREE.BoxGeometry(0.08, 0.42, 0.06), dark, 0, 1.0, -0.36, st);
      this.addMesh(new THREE.BoxGeometry(0.42, 0.03, 0.26), dark, 0, 0.83, -0.34, st);
      this.addMesh(new THREE.PlaneGeometry(1.56, 0.975), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }), 0, 1.42, -0.285, st, false);

      const side = this.addMesh(new THREE.BoxGeometry(0.62, 0.42, 0.04), dark, 1.0, 1.08, -0.2, st);
      side.rotation.set(-0.25, -0.55, 0);
      a.side = this.addMesh(
        new THREE.PlaneGeometry(0.56, 0.36),
        new THREE.MeshBasicMaterial({ color: profile.color, transparent: true, opacity: 0.22, toneMapped: false }),
        0,
        0,
        0.022,
        side,
        false,
      );

      this.addMesh(new THREE.BoxGeometry(0.92, 0.03, 0.3), dark, 0, 0.83, 0.36, st);
      a.keys = this.addMesh(
        new THREE.PlaneGeometry(0.86, 0.24),
        new THREE.MeshBasicMaterial({ color: profile.color, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, toneMapped: false }),
        0,
        0.847,
        0.36,
        st,
        false,
      );
      a.keys.rotation.x = -Math.PI / 2;
      this.addMesh(new THREE.BoxGeometry(0.1, 0.03, 0.16), dark, 0.62, 0.83, 0.38, st);
      this.addMesh(new THREE.CylinderGeometry(0.07, 0.06, 0.16, 16), this.M('#dfe5f5'), -0.98, 0.9, 0.25, st);

      const chair = new THREE.Group();
      chair.position.set(0, 0, 0.98);
      st.add(chair);
      a.chair = chair;
      const cm = this.M('#1b2446', { roughness: 0.5, metalness: 0.4 });
      this.addMesh(new THREE.CylinderGeometry(0.05, 0.05, 0.38, 10), dark, 0, 0.26, 0, chair);
      for (let i = 0; i < 5; i++) {
        const leg = this.addMesh(new THREE.BoxGeometry(0.05, 0.04, 0.36), dark, Math.sin(i * 1.256) * 0.17, 0.06, Math.cos(i * 1.256) * 0.17, chair);
        leg.rotation.y = i * 1.256;
      }
      this.addMesh(new THREE.BoxGeometry(0.66, 0.1, 0.62), cm, 0, 0.5, 0, chair);
      this.addMesh(new THREE.BoxGeometry(0.66, 0.72, 0.08), cm, 0, 0.94, 0.33, chair);
      this.addMesh(new THREE.BoxGeometry(0.5, 0.03, 0.03), this.G(profile.color, 1.4), 0, 1.24, 0.375, chair, false);
      R.group.rotation.y = Math.PI;
      chair.add(R.group);

      a.ring = new THREE.Mesh(new THREE.RingGeometry(0.88, 0.98, 64), ringMat);
      a.ring.rotation.x = -Math.PI / 2;
      a.ring.position.set(0, 0.16, 0.98);
      st.add(a.ring);
      a.light.position.set(0, 1.6, 0);
      st.add(a.light);
    } else {
      st.add(R.group);
      this.addMesh(new THREE.CylinderGeometry(0.9, 1, 0.08, 48), this.M('#121a38', { metalness: 0.7, roughness: 0.3 }), 0, 0.18, 0, st);
      a.ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1.02, 64), ringMat);
      a.ring.rotation.x = -Math.PI / 2;
      a.ring.position.y = 0.235;
      st.add(a.ring);
      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(3.4, 2.125),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
      );
      panel.position.set(0, 3.15, -1.1);
      panel.rotation.x = -0.08;
      st.add(panel);
      a.light.position.set(0, 2.2, 0.6);
      st.add(a.light);
    }

    const tag = this.makeTag(a);
    tag.position.set(0, a.tagY, a.layout.seated ? 0.98 : 0);
    st.add(tag);

    const pv = new THREE.Mesh(
      new THREE.BoxGeometry(a.layout.seated ? 2.8 : 2.2, 2.8, a.layout.seated ? 2.6 : 2.2),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    pv.position.set(0, 1.4, a.layout.seated ? 0.4 : 0);
    pv.userData.agent = a.id;
    st.add(pv);
    this.pickables.push(pv);
  }

  private makeTag(a: AgentNode): THREE.Sprite {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 128;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false }));
    sp.scale.set(2.3, 0.575, 1);
    sp.renderOrder = 20;
    a.tag = { c, tex, sp };
    this.drawTag(a);
    return sp;
  }

  private drawTag(a: AgentNode) {
    if (!a.tag) return;
    const c = a.tag.c.getContext('2d')!;
    const st = STATE_META[a.state];
    const profile = AGENT_PROFILES[a.id];
    c.clearRect(0, 0, 512, 128);
    rr(c, 8, 22, 496, 84, 42);
    c.fillStyle = 'rgba(7,11,26,.86)';
    c.fill();
    c.lineWidth = 3;
    c.strokeStyle = a.state === 'offline' ? '#5b6590' : profile.color;
    c.stroke();
    c.shadowColor = st.color;
    c.shadowBlur = 16;
    c.fillStyle = st.color;
    c.beginPath();
    c.arc(54, 64, 11, 0, Math.PI * 2);
    c.fill();
    c.shadowBlur = 0;
    c.font = `700 34px ${DISP}`;
    c.fillStyle = '#eef1ff';
    c.textBaseline = 'middle';
    c.fillText(profile.name, 78, 66);
    c.font = `600 24px ${BODY}`;
    c.fillStyle = st.color;
    c.textAlign = 'right';
    const text = a.label || st.label;
    c.fillText(text.length > 16 ? text.slice(0, 15) + '…' : text, 484, 66);
    c.textAlign = 'left';
    a.tag.tex.needsUpdate = true;
  }

  /* ---------------- Monitor Canvas Rendering ---------------- */

  private drawHeader(c: CanvasRenderingContext2D, a: AgentNode, label: string, col: string) {
    const profile = AGENT_PROFILES[a.id];
    c.fillStyle = 'rgba(255,255,255,.045)';
    c.fillRect(0, 0, SW, 36);
    c.fillStyle = profile.color;
    c.beginPath();
    c.arc(20, 18, 6, 0, Math.PI * 2);
    c.fill();
    c.font = `700 15px ${DISP}`;
    c.fillStyle = '#e8edff';
    c.textBaseline = 'middle';
    c.fillText(profile.name, 34, 19);
    c.font = `600 13px ${MONO}`;
    c.fillStyle = col;
    c.textAlign = 'right';
    c.fillText(label, SW - 16, 19);
    c.textAlign = 'left';
  }

  private drawAtlasScreen(c: CanvasRenderingContext2D, a: AgentNode, t: number) {
    c.fillStyle = '#000';
    c.fillRect(0, 0, SW, SH);
    c.strokeStyle = 'rgba(155,140,255,.7)';
    c.lineWidth = 2;
    rr(c, 6, 6, SW - 12, SH - 12, 16);
    c.stroke();
    c.fillStyle = '#b7acff';
    c.font = `700 16px ${DISP}`;
    c.textBaseline = 'alphabetic';
    c.fillText('ATLAS · MISSION', 24, 38);
    const st = STATE_META[a.state];
    c.fillStyle = st.color;
    c.font = `600 13px ${MONO}`;
    c.textAlign = 'right';
    c.fillText((a.label || st.label).toUpperCase(), SW - 24, 38);
    c.textAlign = 'left';

    if (this.tasks.length > 0) {
      // Dynamic topological layout of real tasks
      const depth = new Map<string, number>();
      const byKey = new Map(this.tasks.map((tk) => [tk.key, tk]));
      const getDepth = (k: string, seen = new Set<string>()): number => {
        if (depth.has(k)) return depth.get(k)!;
        if (seen.has(k)) return 0;
        seen.add(k);
        const tk = byKey.get(k);
        const d = tk && tk.deps.length ? Math.max(...tk.deps.map((dp) => getDepth(dp, seen) + 1)) : 0;
        depth.set(k, d);
        return d;
      };
      this.tasks.forEach((tk) => getDepth(tk.key));
      const maxD = Math.max(0, ...depth.values());
      const cols = new Map<number, TaskView[]>();
      for (const tk of this.tasks) {
        const d = depth.get(tk.key) ?? 0;
        cols.set(d, [...(cols.get(d) ?? []), tk]);
      }
      const pos = new Map<string, [number, number]>();
      for (const [col, list] of cols) {
        const x = maxD === 0 ? SW / 2 : 76 + (col / maxD) * (SW - 152);
        list.forEach((tk, idx) => {
          const y = 95 + ((idx + 0.5) / list.length) * (SH - 150);
          pos.set(tk.key, [x, y]);
        });
      }
      c.lineWidth = 2;
      for (const tk of this.tasks) {
        const p2 = pos.get(tk.key);
        if (!p2) continue;
        for (const dp of tk.deps) {
          const p1 = pos.get(dp);
          if (!p1) continue;
          const srcDone = byKey.get(dp)?.status === 'completed';
          c.strokeStyle = srcDone ? 'rgba(69,240,160,.6)' : 'rgba(120,150,255,.35)';
          c.beginPath();
          c.moveTo(p1[0], p1[1]);
          c.bezierCurveTo((p1[0] + p2[0]) / 2, p1[1], (p1[0] + p2[0]) / 2, p2[1], p2[0], p2[1]);
          c.stroke();
        }
      }
      for (const tk of this.tasks) {
        const p = pos.get(tk.key);
        if (!p) continue;
        const [x, y] = p;
        const col =
          tk.status === 'completed'
            ? '#45f0a0'
            : tk.status === 'running'
              ? '#2fd8ff'
              : tk.status === 'failed'
                ? '#ff5470'
                : tk.status === 'waiting_approval'
                  ? '#ffbe5c'
                  : '#5b6590';
        const pulse = tk.status === 'running' ? 4 + 3 * Math.sin(t * 5) : 0;
        c.fillStyle = col;
        c.globalAlpha = 0.18;
        c.beginPath();
        c.arc(x, y, 22 + pulse, 0, Math.PI * 2);
        c.fill();
        c.globalAlpha = 1;
        c.strokeStyle = col;
        c.beginPath();
        c.arc(x, y, 16, 0, Math.PI * 2);
        c.stroke();
        c.fillStyle = col;
        c.font = `700 12px ${MONO}`;
        c.textAlign = 'center';
        c.fillText(tk.key, x, y + 4);
        c.fillStyle = '#c8ceef';
        c.font = `600 11px ${BODY}`;
        c.fillText(tk.title.slice(0, 18), x, y + 34);
        c.textAlign = 'left';
      }
    } else if (a.lines.length > 0) {
      c.font = `14px ${MONO}`;
      a.lines.slice(-9).forEach((l, i) => {
        c.fillStyle = l.startsWith('›') ? '#d6ddff' : '#9b8cff';
        c.fillText(l.slice(0, 62), 26, 86 + i * 28);
      });
    } else {
      c.font = `600 14px ${MONO}`;
      c.fillStyle = a.state === 'offline' ? '#ffbe5c' : '#8a95bd';
      c.textAlign = 'center';
      c.fillText(a.state === 'offline' ? 'SETUP NEEDED · ASSIGN MODEL IN WORKFORCE' : 'STANDING BY FOR CEO BRIEF', SW / 2, SH / 2);
      c.textAlign = 'left';
    }
  }

  private drawScreen(a: AgentNode, t: number) {
    const c = a.ctx;
    c.save();
    if (a.id === 'atlas') {
      this.drawAtlasScreen(c, a, t);
      c.restore();
      return;
    }

    const g = c.createLinearGradient(0, 0, 0, SH);
    g.addColorStop(0, '#070c1d');
    g.addColorStop(1, '#0b1431');
    c.fillStyle = g;
    c.fillRect(0, 0, SW, SH);

    const st = STATE_META[a.state];
    if (a.state === 'offline') {
      this.drawHeader(c, a, 'SETUP NEEDED', '#ffbe5c');
      c.fillStyle = '#ffbe5c';
      c.font = `700 22px ${DISP}`;
      c.textAlign = 'center';
      c.fillText('OFFLINE', SW / 2, SH / 2 - 12);
      c.font = `600 13px ${MONO}`;
      c.fillStyle = '#8a95bd';
      c.fillText('Assign a provider & model in Workforce', SW / 2, SH / 2 + 22);
      c.textAlign = 'left';
    } else if (a.id === 'scout' && a.browserImg && (a.state === 'browsing' || a.state === 'working' || a.state === 'thinking' || a.state === 'done')) {
      this.drawHeader(c, a, a.state === 'browsing' ? 'BROWSING' : (a.label || st.label).toUpperCase(), st.color);
      c.fillStyle = '#0d1530';
      c.fillRect(0, 36, SW, 34);
      rr(c, 12, 42, SW - 24, 22, 11);
      c.fillStyle = '#050913';
      c.fill();
      c.fillStyle = '#cfd8ff';
      c.font = `12px ${MONO}`;
      c.textBaseline = 'middle';
      c.fillText((a.browserUrl || 'about:blank').slice(0, 68), 24, 53);
      c.drawImage(a.browserImg, 0, 70, SW, SH - 70);
    } else if (a.state === 'waiting') {
      this.drawHeader(c, a, 'AWAITING APPROVAL', '#ffbe5c');
      rr(c, 54, 56, SW - 108, SH - 76, 10);
      c.fillStyle = '#f4f1ea';
      c.fill();
      c.fillStyle = '#1b2340';
      c.font = `700 17px ${BODY}`;
      c.textBaseline = 'alphabetic';
      c.fillText((a.approvalSummary || 'External action awaiting CEO decision').slice(0, 46), 74, 98);
      c.fillStyle = '#6b7390';
      c.font = `13px ${MONO}`;
      c.fillText('Paused until you approve or reject.', 74, 124);
      c.save();
      c.translate(SW - 190, SH - 92);
      c.rotate(-0.15);
      const p = 0.75 + 0.25 * Math.sin(t * 4);
      c.strokeStyle = `rgba(255,160,40,${p})`;
      c.lineWidth = 3;
      rr(c, -110, -24, 220, 48, 8);
      c.stroke();
      c.fillStyle = `rgba(230,130,20,${p})`;
      c.font = `700 14px ${MONO}`;
      c.textAlign = 'center';
      c.fillText('AWAITING CEO', 0, -2);
      c.fillText('APPROVAL', 0, 16);
      c.textAlign = 'left';
      c.restore();
    } else if (a.state === 'error') {
      c.fillStyle = 'rgba(255,84,112,.16)';
      c.fillRect(0, 36, SW, 42);
      this.drawHeader(c, a, 'ERROR', '#ff5470');
      c.font = `14px ${MONO}`;
      c.textBaseline = 'alphabetic';
      const ls = a.lines.slice(-11);
      let y = 66;
      ls.forEach((l) => {
        c.fillStyle = lineColor(l);
        c.fillText(l.slice(0, 62), 18, y);
        y += 24;
      });
      if (a.detail) {
        c.fillStyle = 'rgba(255,84,112,.85)';
        rr(c, 16, SH - 46, SW - 32, 32, 8);
        c.fill();
        c.fillStyle = '#fff';
        c.font = `700 12px ${MONO}`;
        c.fillText(a.detail.slice(0, 64), 26, SH - 26);
      }
    } else if (a.state === 'working' || a.state === 'thinking' || a.state === 'browsing') {
      this.drawHeader(c, a, (a.label || st.label).toUpperCase(), st.color);
      c.font = `14px ${MONO}`;
      c.textBaseline = 'alphabetic';
      const ls = a.lines.slice(-13);
      let y = 66;
      ls.forEach((l) => {
        c.fillStyle = lineColor(l);
        c.fillText(l.length > 62 ? l.slice(0, 61) + '…' : l, 18, y);
        y += 24;
      });
      if (Math.floor(t * 2) % 2 === 0) {
        c.fillStyle = st.color;
        c.fillRect(18, y - 14, 9, 17);
      }
    } else if (a.state === 'done') {
      this.drawHeader(c, a, 'COMPLETED', '#45f0a0');
      c.strokeStyle = '#45f0a0';
      c.lineWidth = 6;
      c.beginPath();
      c.arc(110, 190, 52, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.moveTo(84, 192);
      c.lineTo(103, 210);
      c.lineTo(138, 170);
      c.stroke();
      c.font = `700 20px ${BODY}`;
      c.fillStyle = '#e8edff';
      c.textBaseline = 'alphabetic';
      c.fillText('Task complete', 196, 160);
      c.font = `13px ${MONO}`;
      c.fillStyle = '#8a95bd';
      c.fillText((a.detail || 'Deliverables written').slice(0, 42), 196, 194);
    } else {
      const profile = AGENT_PROFILES[a.id];
      this.drawHeader(c, a, (a.label || 'IDLE').toUpperCase(), '#8a95bd');
      const cx = SW / 2;
      const cy = SH / 2 + 14;
      for (let i = 0; i < 3; i++) {
        const rad = 60 + i * 26 + Math.sin(t * 1.2 + i) * 4;
        c.strokeStyle = profile.color;
        c.globalAlpha = 0.22 - i * 0.06;
        c.lineWidth = 2;
        c.beginPath();
        c.arc(cx, cy, rad, 0, Math.PI * 2);
        c.stroke();
      }
      c.globalAlpha = 1;
      c.fillStyle = profile.color;
      c.font = `700 64px ${DISP}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(profile.glyph, cx, cy + 3);
      c.font = `600 13px ${MONO}`;
      c.fillStyle = '#8a95bd';
      c.fillText(a.label || 'Standing by', cx, SH - 36);
      c.textAlign = 'left';
      c.textBaseline = 'alphabetic';
    }

    c.fillStyle = 'rgba(255,255,255,.025)';
    for (let y = 0; y < SH; y += 4) c.fillRect(0, y, SW, 1);
    c.restore();
  }

  /* ---------------- Animation & Loop ---------------- */

  private animateAgent(a: AgentNode, t: number, dt: number) {
    const R = a.R;
    if (!R) return;
    const s = a.state;
    const ph = a.layout.pos[0];
    const k = 1 - Math.exp(-dt * 7);
    const profile = AGENT_PROFILES[a.id];

    R.torso.scale.y = s === 'offline' ? 1.12 : 1.12 * (1 + 0.018 * Math.sin(t * 2.1 + ph));
    let tg = a.layout.seated
      ? { lx: -0.25, lz: 0.05, lex: -0.9, rx: -0.25, rz: -0.05, rex: -0.9, rez: 0, hx: 0, hy: 0.3 * Math.sin(t * 0.35 + ph), hz: 0 }
      : { lx: -0.1, lz: 0.18, lex: -0.3, rx: -0.1, rz: -0.18, rex: -0.3, rez: 0, hx: 0, hy: 0.25 * Math.sin(t * 0.3), hz: 0 };

    if (s === 'offline') {
      tg = { lx: 0.05, lz: 0.08, lex: -0.15, rx: 0.05, rz: -0.08, rex: -0.15, rez: 0, hx: 0.28, hy: 0, hz: 0 };
    } else if (s === 'working') {
      tg = a.layout.seated
        ? { lx: -0.75, lz: 0.12, lex: -0.3 + 0.12 * Math.sin(t * 19), rx: -0.75, rz: -0.12, rex: -0.3 + 0.12 * Math.sin(t * 19 + 1.9), rez: 0, hx: 0.14 + 0.03 * Math.sin(t * 3), hy: 0.06 * Math.sin(t * 0.8), hz: 0 }
        : { lx: -1.0 + 0.25 * Math.sin(t * 2.2), lz: 0.5, lex: -0.5, rx: -1.0 + 0.25 * Math.sin(t * 2.2 + 2), rz: -0.5, rex: -0.5, rez: 0, hx: -0.05, hy: 0.2 * Math.sin(t * 0.9), hz: 0 };
    } else if (s === 'browsing') {
      tg = { lx: -0.35, lz: 0.12, lex: -1.0, rx: -0.7, rz: -0.18, rex: -0.35 + 0.05 * Math.sin(t * 4), rez: 0, hx: 0.12, hy: 0.12 * Math.sin(t * 0.7), hz: 0 };
    } else if (s === 'thinking') {
      tg = { lx: -0.3, lz: 0.1, lex: -0.9, rx: -1.25, rz: 0.25, rex: -1.95, rez: 0, hx: -0.12, hy: 0.15 * Math.sin(t * 0.6), hz: 0.16 };
    } else if (s === 'error') {
      tg = { lx: 0.02, lz: 0.1, lex: -0.2, rx: 0.02, rz: -0.1, rex: -0.2, rez: 0, hx: 0.38, hy: 0, hz: -0.1 };
    } else if (s === 'waiting') {
      tg = { lx: -0.3, lz: 0.08, lex: -0.9, rx: -0.3, rz: -0.08, rex: -0.9, rez: 0, hx: -0.05, hy: 0.35 * Math.sin(t * 0.9), hz: 0 };
    }
    if (a.waving) {
      tg.rx = 0;
      tg.rz = 2.55;
      tg.rex = 0;
      tg.rez = 0.35 + 0.45 * Math.sin(t * 11);
      tg.hx = -0.08;
      tg.hy = 0;
    }

    R.L.sh.rotation.x = lerp(R.L.sh.rotation.x, tg.lx, k);
    R.L.sh.rotation.z = lerp(R.L.sh.rotation.z, tg.lz, k);
    R.L.el.rotation.x = lerp(R.L.el.rotation.x, tg.lex, k);
    R.R.sh.rotation.x = lerp(R.R.sh.rotation.x, tg.rx, k);
    R.R.sh.rotation.z = lerp(R.R.sh.rotation.z, tg.rz, k);
    R.R.el.rotation.x = lerp(R.R.el.rotation.x, tg.rex, k);
    R.R.el.rotation.z = lerp(R.R.el.rotation.z, tg.rez, k);
    R.head.rotation.x = lerp(R.head.rotation.x, tg.hx, k);
    R.head.rotation.y = lerp(R.head.rotation.y, tg.hy, k);
    R.head.rotation.z = lerp(R.head.rotation.z, tg.hz, k);
    R.head.position.y = 1.68 + (s === 'offline' ? 0 : 0.012 * Math.sin(t * 2.1 + ph + 0.6));

    const bl = s === 'offline' ? 0.15 : (t + ph * 1.7) % 4.2 < 0.12 ? 0.15 : 1;
    R.eyes.forEach((e) => {
      e.scale.y = lerp(e.scale.y, bl, 0.6);
    });

    const tv = s === 'thinking' ? 1 : 0.001;
    const ts = lerp(R.thought.scale.x, tv, k);
    R.thought.scale.setScalar(ts);
    if (ts > 0.01) {
      R.thoughtCore.rotation.y += dt * 1.8;
      R.thoughtCore.rotation.x += dt * 0.9;
      R.orbs.forEach((o, i) => {
        const an = t * 2.2 + i * 2.094;
        o.position.set(Math.cos(an) * 0.3, Math.sin(an * 1.3) * 0.08, Math.sin(an) * 0.3);
      });
      R.thought.position.y = (a.layout.seated ? 2.42 : 2.74) + 0.06 * Math.sin(t * 2);
    }

    if (R.halo) {
      R.halo.rotation.z += dt * 0.8;
      R.halo.position.y = 0.5 + 0.03 * Math.sin(t * 2);
    }
    if (!a.layout.seated) {
      R.body.position.y = 0.32 + (s === 'offline' ? -0.08 : 0.07 * Math.sin(t * 1.6));
      if (R.hoverRing) R.hoverRing.scale.setScalar(1 + 0.06 * Math.sin(t * 3));
    }
    if (R.beacon) {
      (R.beacon.material as THREE.MeshStandardMaterial).emissiveIntensity =
        s === 'offline' ? 0.2 : 1.5 + 1.5 * Math.max(0, Math.sin(t * (s === 'browsing' ? 8 : 2)));
    }
    if (R.drone) {
      const r = s === 'browsing' ? 0.95 : 0.7;
      const sp = s === 'browsing' ? 1.6 : s === 'offline' ? 0.1 : 0.5;
      R.drone.position.set(Math.cos(t * sp) * r, 2.15 + 0.12 * Math.sin(t * 2.4), Math.sin(t * sp) * r);
      R.drone.rotation.y = t * 3;
    }
    if (R.waves) {
      R.waves.forEach((w, i) => {
        const p = (t * 0.7 + i * 0.5) % 1;
        const on = s === 'working' ? 1 : 0;
        w.scale.setScalar(1 + p * 2.2);
        (w.material as THREE.MeshBasicMaterial).opacity = on * (1 - p) * 0.7;
      });
    }

    const col = STATE_META[s].color;
    if (a.keys) (a.keys.material as THREE.MeshBasicMaterial).opacity = s === 'working' ? 0.25 + 0.2 * Math.abs(Math.sin(t * 14)) : 0.1;
    if (a.side) (a.side.material as THREE.MeshBasicMaterial).opacity = s === 'offline' ? 0.06 : 0.14 + 0.08 * Math.sin(t * 1.5 + ph);
    if (a.light) {
      const li = s === 'offline' ? 0.25 : s === 'error' ? 1.6 + 1.2 * Math.max(0, Math.sin(t * 7)) : s === 'idle' ? 0.7 : 1.3;
      a.light.intensity = lerp(a.light.intensity, li, k);
      a.light.color.lerp(this.tmpColor.set(s === 'error' ? '#ff5470' : s === 'waiting' || s === 'offline' ? '#ffbe5c' : profile.color), k);
    }
    if (a.ring) {
      (a.ring.material as THREE.MeshBasicMaterial).color.lerp(this.tmpColor.set(s === 'idle' ? profile.color : col), k);
    }
    if (a.tag) {
      a.tag.sp.position.y = a.tagY + 0.05 * Math.sin(t * 1.8 + ph);
    }
  }

  private anchorWorld(id: AgentId): THREE.Vector3 {
    const a = this.agents[id];
    return a.st!.localToWorld(a.anchor.clone());
  }

  private flashRing(id: AgentId) {
    const a = this.agents[id];
    if (!a?.ring) return;
    gsap.fromTo(a.ring.material as THREE.MeshBasicMaterial, { opacity: 1 }, { opacity: 0.45, duration: 1.1 });
    gsap.fromTo(a.ring.scale, { x: 1.35, y: 1.35 }, { x: 1, y: 1, duration: 0.9, ease: 'power3.out' });
  }

  private burst(id: AgentId) {
    if (!this.scene || !this.softDotTex) return;
    const p = this.anchorWorld(id);
    const N = 70;
    const pos = new Float32Array(N * 3);
    const vel: THREE.Vector3[] = [];
    for (let i = 0; i < N; i++) {
      pos.set([p.x, p.y - 0.2, p.z], i * 3);
      const th = Math.random() * 6.28;
      const ph = Math.random() * 1.2;
      vel.push(new THREE.Vector3(Math.cos(th) * Math.sin(ph) * 2.4, 1.5 + Math.random() * 2.8, Math.sin(th) * Math.sin(ph) * 2.4));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ size: 0.13, map: this.softDotTex, color: '#7dffc4', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const pts = new THREE.Points(g, m);
    this.scene.add(pts);
    this.bursts.push({ pts, vel, life: 0 });

    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d')!;
    x.fillStyle = '#45f0a0';
    x.beginPath();
    x.arc(64, 64, 54, 0, Math.PI * 2);
    x.fill();
    x.strokeStyle = '#04130d';
    x.lineWidth = 12;
    x.lineCap = 'round';
    x.beginPath();
    x.moveTo(38, 66);
    x.lineTo(56, 84);
    x.lineTo(92, 46);
    x.stroke();
    const b = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false, toneMapped: false }));
    b.renderOrder = 21;
    b.position.copy(p).add(new THREE.Vector3(0, 0.5, 0));
    b.scale.set(0.01, 0.01, 1);
    this.scene.add(b);
    gsap.to(b.scale, { x: 0.55, y: 0.55, duration: 0.5, ease: 'back.out(3)' });
    gsap.to(b.position, { y: '+=.5', duration: 2.4, ease: 'sine.out' });
    gsap.to(b.material, { opacity: 0, duration: 0.6, delay: 2.2, onComplete: () => { this.scene?.remove(b); } });
  }

  private setupPicking(canvas: HTMLCanvasElement) {
    const ray = new THREE.Raycaster();
    const v = new THREE.Vector2();
    let down: [number, number] | null = null;
    let hoverId: AgentId | null = null;

    const pick = (e: PointerEvent): AgentId | null => {
      if (!this.camera) return null;
      const r = canvas.getBoundingClientRect();
      v.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(v, this.camera);
      const h = ray.intersectObjects(this.pickables, false)[0];
      return (h?.object.userData.agent as AgentId) ?? null;
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const id = pick(e);
      if (id !== hoverId) {
        hoverId = id;
        canvas.classList.toggle('hovering', !!id);
        if (id) this.flashRing(id);
      }
    };
    const onDown = (e: PointerEvent) => {
      down = [e.clientX, e.clientY];
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
      down = null;
      if (moved > 6) return;
      const id = pick(e);
      if (id) {
        this.opts.onSelectAgent?.(id);
        this.focusAgent(id);
      }
    };

    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    this.cleanupListeners.push(() => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
    });
  }

  private flyTo(pos: THREE.Vector3, target: THREE.Vector3, dur?: number) {
    if (!this.has3D || !this.camera || !this.controls) return;
    const d = this.reduceMotion ? 0 : dur ?? 1.5;
    gsap.to(this.camera.position, { x: pos.x, y: pos.y, z: pos.z, duration: d, ease: 'power3.inOut' });
    gsap.to(this.controls.target, { x: target.x, y: target.y, z: target.z, duration: d, ease: 'power3.inOut' });
  }

  private resize() {
    if (!this.renderer || !this.camera) return;
    const el = this.opts.container;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const portrait = w / h < 1.05;
    this.camera.fov = portrait ? 40 : 30;
    this.camera.updateProjectionMatrix();
    const home = portrait ? this.homeTarget.clone().add(this.homeBase.clone().sub(this.homeTarget).multiplyScalar(1.25)) : this.homeBase.clone();
    if (!this.homePos.equals(home)) {
      const atHome = this.camera.position.distanceTo(this.homePos) < 0.01;
      this.homePos.copy(home);
      if (atHome) this.camera.position.copy(home);
    }
  }

  private loop = () => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);
    const now = performance.now() / 1000;

    // Update monitor textures (~10 fps) + inspector mirror canvas
    if (now - this.screenT > 0.1) {
      this.screenT = now;
      for (const id of AGENT_IDS) {
        const a = this.agents[id];
        this.drawScreen(a, now);
        if (a.tex) a.tex.needsUpdate = true;
      }
      if (this.mirrorCanvas) {
        const mctx = this.mirrorCanvas.getContext('2d');
        const sel = this.agents[this.selectedId];
        if (mctx && sel) {
          mctx.fillStyle = '#04060d';
          mctx.fillRect(0, 0, SW, SH);
          mctx.drawImage(sel.cv, 0, 0);
        }
      }
    }

    if (!this.has3D || !this.visible || !this.renderer || !this.scene || !this.camera || !this.controls || !this.clock3) return;
    const dt = Math.min(this.clock3.getDelta(), 0.05);
    const t = this.clock3.elapsedTime * (this.reduceMotion ? 0.4 : 1);

    if (this.gridMat) this.gridMat.uniforms.uTime.value = t;
    this.holo.rings.forEach((ring, i) => {
      ring.rotation.z += dt * (i % 2 ? -0.6 : 0.9);
      ring.position.y = 1.25 + i * 0.22 + 0.04 * Math.sin(t * 1.5 + i);
    });
    if (this.holo.core) {
      this.holo.core.rotation.y += dt * 0.7;
      this.holo.core.rotation.x += dt * 0.3;
    }
    if (this.dust) {
      const dp = this.dust.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < dp.count; i++) {
        let y = dp.getY(i) + dt * 0.12;
        if (y > 7) y = 0;
        dp.setY(i, y);
      }
      dp.needsUpdate = true;
    }
    if (this.frames % 12 === 0) {
      this.holo.racks.forEach(({ rc, tex }) => {
        const x = rc.getContext('2d')!;
        x.fillStyle = '#070b18';
        x.fillRect(0, 0, 64, 128);
        for (let r = 0; r < 14; r++) {
          for (let col = 0; col < 4; col++) {
            x.fillStyle = Math.random() < 0.35 ? (Math.random() < 0.5 ? '#2fd8ff' : '#45f0a0') : '#1a2342';
            x.fillRect(6 + col * 14, 6 + r * 8.6, 9, 4);
          }
        }
        tex.needsUpdate = true;
      });
    }

    for (const id of AGENT_IDS) this.animateAgent(this.agents[id], t, dt);

    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.life += dt;
      const p = b.pts.geometry.attributes.position as THREE.BufferAttribute;
      b.vel.forEach((v, j) => {
        v.y -= dt * 4.5;
        p.setXYZ(j, p.getX(j) + v.x * dt, p.getY(j) + v.y * dt, p.getZ(j) + v.z * dt);
      });
      p.needsUpdate = true;
      (b.pts.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - b.life / 1.6);
      if (b.life > 1.6) {
        this.scene.remove(b.pts);
        b.pts.geometry.dispose();
        this.bursts.splice(i, 1);
      }
    }

    this.controls.target.x = THREE.MathUtils.clamp(this.controls.target.x, -9, 9);
    this.controls.target.z = THREE.MathUtils.clamp(this.controls.target.z, -8, 6);
    this.controls.target.y = THREE.MathUtils.clamp(this.controls.target.y, 0, 3);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);

    this.frames++;
    this.fpsAcc += dt;
    if (this.fpsAcc >= 1) {
      const fps = Math.round(this.frames - this.fpsT);
      this.fpsT = this.frames;
      this.fpsAcc = 0;
      this.opts.onPerf?.(`${fps} fps · ${this.lowered ? 'adaptive low' : 'high'}`);
      if (fps < 40 && !this.lowered && this.frames > 120) {
        this.lowered = true;
        this.renderer.setPixelRatio(1);
        if (this.dirLight) this.dirLight.castShadow = false;
        this.resize();
      }
    }
  };
}
