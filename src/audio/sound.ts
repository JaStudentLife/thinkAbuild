import type { SoundKind } from '../core/materials';

/** Procedural sound effects (WebAudio, no samples). */
class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private recent = 0;
  muted = false;

  private ensure(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.55;
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 6;
        this.master.connect(comp).connect(this.ctx.destination);
        const len = this.ctx.sampleRate * 2;
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** limit the number of overlapping effects */
  private budget(): boolean {
    const now = performance.now();
    if (now - this.recent < 18) return false;
    this.recent = now;
    return true;
  }

  private noiseBurst(t: number, dur: number, freq: number, q: number, gain: number, type: BiquadFilterType = 'bandpass') {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  private tone(t: number, freq: number, dur: number, gain: number, type: OscillatorType = 'sine', slideTo?: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** a part breaking */
  fracture(kind: SoundKind, intensity: number) {
    const ctx = this.ensure();
    if (!ctx || !this.budget()) return;
    const t = ctx.currentTime + 0.005;
    const k = Math.max(0.15, Math.min(1, intensity));
    switch (kind) {
      case 'wood': {
        this.noiseBurst(t, 0.06, 2800, 1.2, 0.9 * k);
        this.noiseBurst(t, 0.16, 520, 1.5, 0.7 * k);
        for (let i = 0; i < 6; i++) this.noiseBurst(t + 0.02 + Math.random() * 0.18, 0.025, 1500 + Math.random() * 3000, 3, 0.25 * k);
        this.tone(t, 180, 0.12, 0.25 * k, 'triangle', 70);
        break;
      }
      case 'glass': {
        this.noiseBurst(t, 0.12, 5200, 0.8, 0.8 * k, 'highpass');
        for (let i = 0; i < 26; i++) this.tone(t + Math.random() * 0.45, 2400 + Math.random() * 5200, 0.08 + Math.random() * 0.25, 0.06 * k);
        break;
      }
      case 'stone': {
        this.noiseBurst(t, 0.2, 900, 0.8, 0.9 * k, 'lowpass');
        for (let i = 0; i < 14; i++) this.noiseBurst(t + Math.random() * 0.5, 0.05 + Math.random() * 0.08, 300 + Math.random() * 1500, 1.5, 0.3 * k);
        this.tone(t, 90, 0.25, 0.4 * k, 'sine', 40);
        break;
      }
      case 'metal': {
        // bending groan + snap
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(140, t);
        o.frequency.linearRampToValueAtTime(70, t + 0.5);
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 600;
        f.Q.value = 4;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25 * k, t + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
        o.connect(f).connect(g).connect(this.master!);
        o.start(t);
        o.stop(t + 0.6);
        this.clangAt(t, 420, 0.5 * k);
        break;
      }
      case 'plastic':
        this.noiseBurst(t, 0.07, 1800, 1, 0.6 * k);
        this.tone(t, 300, 0.1, 0.2 * k, 'triangle', 150);
        break;
      default:
        this.noiseBurst(t, 0.12, 400, 0.7, 0.5 * k, 'lowpass');
    }
  }

  private clangAt(t: number, f0: number, gain: number) {
    const parts = [1, 2.76, 5.4, 8.93];
    parts.forEach((m, i) => this.tone(t, f0 * m * (0.98 + Math.random() * 0.04), 0.9 / (1 + i * 0.6), gain / (1 + i)));
    this.noiseBurst(t, 0.02, 4000, 1, gain * 0.6, 'highpass');
  }

  /** collision sound; intensity 0..1, size in metres */
  impact(kind: SoundKind, intensity: number, size = 0.3) {
    const ctx = this.ensure();
    if (!ctx || intensity < 0.04 || !this.budget()) return;
    const t = ctx.currentTime + 0.003;
    const k = Math.min(1, intensity);
    const pitch = Math.max(0.4, Math.min(2.5, 0.3 / Math.max(0.03, size)));
    switch (kind) {
      case 'metal':
        this.clangAt(t, 260 * pitch, 0.45 * k);
        this.tone(t, 70, 0.2, 0.5 * k, 'sine', 40);
        break;
      case 'glass':
        this.tone(t, 2200 * pitch, 0.3, 0.2 * k);
        this.noiseBurst(t, 0.03, 4000, 1, 0.3 * k, 'highpass');
        break;
      case 'wood':
        this.noiseBurst(t, 0.06, 900 * pitch, 2, 0.55 * k);
        this.tone(t, 160 * pitch, 0.12, 0.35 * k, 'triangle', 90 * pitch);
        break;
      case 'stone':
        this.noiseBurst(t, 0.1, 500 * pitch, 1, 0.6 * k, 'lowpass');
        this.tone(t, 80, 0.2, 0.45 * k, 'sine', 45);
        break;
      default:
        this.noiseBurst(t, 0.08, 350, 0.7, 0.4 * k, 'lowpass');
        this.tone(t, 90, 0.12, 0.3 * k, 'sine', 50);
    }
    if (k > 0.6) this.tone(t, 55, 0.35, 0.6 * k, 'sine', 30);
  }

  /** a structure groaning under load before it fails */
  creak(kind: SoundKind, duration = 0.4) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + 0.01;
    if (kind === 'wood' || kind === 'plastic') {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const base = 55 + Math.random() * 40;
      o.frequency.setValueAtTime(base, t);
      for (let i = 1; i < 10; i++) o.frequency.linearRampToValueAtTime(base * (0.8 + Math.random() * 0.6), t + (duration * i) / 10);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 900 + Math.random() * 600;
      f.Q.value = 6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      for (let i = 0; i < 8; i++) {
        const tt = t + (duration * i) / 8;
        g.gain.linearRampToValueAtTime(0.18 + Math.random() * 0.2, tt + 0.01);
        g.gain.linearRampToValueAtTime(0.03, tt + duration / 10);
      }
      g.gain.linearRampToValueAtTime(0.0001, t + duration);
      o.connect(f).connect(g).connect(this.master!);
      o.start(t);
      o.stop(t + duration + 0.05);
    } else if (kind === 'metal') {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(180, t);
      o.frequency.linearRampToValueAtTime(110, t + duration);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 700;
      f.Q.value = 8;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.16, t + duration * 0.3);
      g.gain.linearRampToValueAtTime(0.0001, t + duration);
      o.connect(f).connect(g).connect(this.master!);
      o.start(t);
      o.stop(t + duration + 0.05);
    } else if (kind === 'stone' || kind === 'glass') {
      for (let i = 0; i < 5; i++) this.noiseBurst(t + Math.random() * duration, 0.02, kind === 'glass' ? 6000 : 2500, 4, 0.12);
    }
  }

  whoosh() {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.noiseBurst(t, 0.35, 700, 0.6, 0.25, 'bandpass');
  }

  // ------------------------------------------------------------------ workshop tools

  /** one stroke of a hand saw / hacksaw / knife: a rasp whose colour depends on the material */
  sawStroke(kind: 'handsaw' | 'finesaw' | 'hacksaw' | 'knife' | 'snow', push: boolean, hard = 0.5) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + 0.002;
    const g = push ? 0.32 : 0.2;
    switch (kind) {
      case 'hacksaw':
        this.noiseBurst(t, 0.16, 5200 + hard * 1500, 2.2, g * 0.8);
        this.tone(t, 2400 + Math.random() * 300, 0.12, 0.02);
        break;
      case 'knife':
        this.noiseBurst(t, 0.12, 2600, 0.9, g * 0.45, 'bandpass');
        break;
      case 'snow':
        this.noiseBurst(t, 0.14, 4200, 0.8, g * 0.6, 'highpass');
        break;
      default:
        this.noiseBurst(t, 0.15, 2600 + hard * 1600, 1.3, g);
        this.noiseBurst(t + 0.02, 0.1, 900 + hard * 500, 1.5, g * 0.35);
    }
  }

  private loop: { stop: () => void } | null = null;

  /** angle grinder / diamond blade running (and biting) */
  grinderStart(kind: 'metal' | 'stone', hard = 0.5) {
    this.grinderStop();
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(kind === 'metal' ? 330 : 290, t + 0.35);
    const of = ctx.createBiquadFilter();
    of.type = 'bandpass';
    of.frequency.value = 1400;
    of.Q.value = 1.2;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.09, t + 0.2);
    o.connect(of).connect(og).connect(this.master!);
    o.start(t);
    // the bite: screaming high noise for metal, gritty mid noise for stone
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = kind === 'metal' ? 5200 + hard * 2500 : 1800;
    nf.Q.value = kind === 'metal' ? 3 : 0.8;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(kind === 'metal' ? 0.2 : 0.28, t + 0.3);
    src.connect(nf).connect(ng).connect(this.master!);
    src.start(t);
    this.loop = {
      stop: () => {
        const now = ctx.currentTime;
        og.gain.cancelScheduledValues(now);
        og.gain.setValueAtTime(Math.max(0.0002, og.gain.value), now);
        og.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
        o.frequency.cancelScheduledValues(now);
        o.frequency.setValueAtTime(o.frequency.value, now);
        o.frequency.exponentialRampToValueAtTime(60, now + 0.5);
        ng.gain.cancelScheduledValues(now);
        ng.gain.setValueAtTime(Math.max(0.0002, ng.gain.value), now);
        ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
        o.stop(now + 0.55);
        src.stop(now + 0.2);
      },
    };
  }

  grinderStop() {
    if (this.loop) {
      try {
        this.loop.stop();
      } catch {
        /* already stopped */
      }
      this.loop = null;
    }
  }

  /** a glass cutter's wheel running along the score line */
  glassScore() {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.noiseBurst(t, 0.5, 7200, 2.5, 0.12, 'bandpass');
    this.tone(t, 3100, 0.45, 0.015);
  }

  /** the clean snap of scored glass */
  glassSnap() {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.noiseBurst(t, 0.03, 5000, 1, 0.5, 'highpass');
    this.tone(t, 2900, 0.12, 0.12);
    this.tone(t, 4700, 0.08, 0.06);
  }

  /** gluing, screwing, bolting, welding or prying two parts */
  join(kind: 'glue' | 'screw' | 'bolt' | 'weld' | 'rigid' | 'rest') {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + 0.003;
    switch (kind) {
      case 'glue':
        this.noiseBurst(t, 0.18, 500, 0.8, 0.25, 'lowpass');
        this.tone(t + 0.02, 220, 0.12, 0.05, 'sine', 140);
        break;
      case 'screw':
        for (let i = 0; i < 2; i++) {
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(95, t + i * 0.32);
          o.frequency.linearRampToValueAtTime(140, t + i * 0.32 + 0.26);
          const f = ctx.createBiquadFilter();
          f.type = 'bandpass';
          f.frequency.value = 1100;
          f.Q.value = 2;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t + i * 0.32);
          g.gain.exponentialRampToValueAtTime(0.16, t + i * 0.32 + 0.03);
          g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.32 + 0.28);
          o.connect(f).connect(g).connect(this.master!);
          o.start(t + i * 0.32);
          o.stop(t + i * 0.32 + 0.3);
          this.noiseBurst(t + i * 0.32 + 0.26, 0.03, 2500, 2, 0.2);
        }
        break;
      case 'bolt':
        this.clangAt(t, 520, 0.18);
        for (let i = 0; i < 4; i++) this.noiseBurst(t + 0.12 + i * 0.09, 0.03, 3200, 4, 0.12);
        this.clangAt(t + 0.5, 610, 0.12);
        break;
      case 'weld':
        for (let i = 0; i < 26; i++) this.noiseBurst(t + Math.random() * 0.9, 0.02 + Math.random() * 0.04, 3000 + Math.random() * 4000, 1.5, 0.14 + Math.random() * 0.1);
        this.noiseBurst(t, 0.9, 6000, 0.6, 0.05, 'highpass');
        break;
      case 'rigid':
        this.clangAt(t, 300, 0.2);
        break;
      case 'rest':
        // prying apart: a creak and a pop
        this.creak('wood', 0.35);
        this.noiseBurst(t + 0.36, 0.05, 1600, 1.2, 0.5);
        this.tone(t + 0.36, 160, 0.1, 0.2, 'triangle', 80);
        break;
    }
  }
}

export const sound = new SoundEngine();
