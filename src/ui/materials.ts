import type { App } from '../app';
import { CATEGORIES, MATERIALS, formatPa, getMaterial, type Material } from '../core/materials';
import { swatchDataURL } from '../render/textures';
import { clear, h } from './dom';

const swatches = new Map<string, string>();
export function swatch(m: Material): string {
  let s = swatches.get(m.id);
  if (!s) {
    s = swatchDataURL(m);
    swatches.set(m.id, s);
  }
  return s;
}

export function materialCard(m: Material): HTMLElement {
  const rows: [string, string][] = [
    ['Density', `${m.density.toLocaleString()} kg/m³`],
    ['Stiffness E', formatPa(m.E)],
  ];
  if (m.ductile) {
    rows.push(['Yield', formatPa(m.fy ?? m.ft)], ['Ultimate', formatPa(m.fu ?? m.ft)]);
  } else {
    rows.push(['Compression', formatPa(m.fc)], ['Tension', formatPa(m.ft)], ['Bending', formatPa(m.fm)]);
  }
  rows.push(['Shear', formatPa(m.fv)]);
  if (m.grain === 'solid') rows.push(['Across grain', `${formatPa(m.fcPerp ?? 0)} crush`]);
  rows.push(['Behaviour', m.ductile ? 'Ductile: bends and yields' : { splinter: 'Brittle: snaps and splinters', shatter: 'Brittle: shatters', dice: 'Shatters into small cubes', crumble: 'Quasi-brittle: cracks and crumbles', crush: 'Crushes', tear: 'Stretches, then tears', bend: 'Bends' }[m.failure]]);
  rows.push(['Friction μ', m.friction.toFixed(2)]);
  return h(
    'div',
    { class: 'mat-card' },
    h('h3', {}, m.name),
    h('p', {}, m.blurb),
    h('div', { class: 'props' }, ...rows.flatMap(([k, v]) => [h('span', {}, k), h('span', {}, v)])),
  );
}

export class MaterialsPanel {
  private el: HTMLElement;
  private app: App;
  private filter = '';
  private hover: string | null = null;
  private list!: HTMLElement;
  private card!: HTMLElement;

  constructor(el: HTMLElement, app: App) {
    this.el = el;
    this.app = app;
    this.build();
    app.on('selection', () => this.renderList());
    app.on('design', () => this.renderList());
  }

  private build() {
    clear(this.el);
    const search = h('input', { type: 'search', placeholder: 'Search materials…' });
    search.addEventListener('input', () => {
      this.filter = search.value.toLowerCase();
      this.renderList();
    });
    this.el.appendChild(h('div', { class: 'panel-h' }, h('h2', {}, 'Materials'), search));
    this.list = h('div');
    this.card = h('div');
    this.el.append(this.list, this.card);
    this.renderList();
  }

  private current(): string {
    const sel = this.app.part(this.app.selection);
    return sel ? sel.material : this.app.activeMaterial;
  }

  renderList() {
    clear(this.list);
    const cur = this.current();
    for (const cat of CATEGORIES) {
      const mats = MATERIALS.filter((m) => m.category === cat && (!this.filter || m.name.toLowerCase().includes(this.filter) || cat.toLowerCase().includes(this.filter)));
      if (!mats.length) continue;
      this.list.appendChild(h('div', { class: 'cat' }, cat));
      const grid = h('div', { class: 'mat-grid' });
      for (const m of mats) {
        const tile = h(
          'div',
          { class: `mat ${m.id === cur ? 'active' : ''}`, title: m.blurb },
          h('img', { src: swatch(m), alt: '' }),
          h('div', { style: { minWidth: '0' } }, h('div', { class: 'mname' }, m.name), h('div', { class: 'mden' }, `${(m.density / 1000).toFixed(m.density < 1000 ? 3 : 2)} g/cm³`)),
        );
        tile.addEventListener('click', () => this.pick(m.id));
        tile.addEventListener('mouseenter', () => {
          this.hover = m.id;
          this.renderCard();
        });
        tile.addEventListener('mouseleave', () => {
          this.hover = null;
          this.renderCard();
        });
        grid.appendChild(tile);
      }
      this.list.appendChild(grid);
    }
    this.renderCard();
  }

  private renderCard() {
    clear(this.card);
    this.card.appendChild(materialCard(getMaterial(this.hover ?? this.current())));
  }

  private pick(id: string) {
    const app = this.app;
    app.activeMaterial = id;
    if (app.mode === 'build' && app.selection) app.updatePart(app.selection, { material: id });
    this.renderList();
    app.emit('settings');
  }
}
