import type { Design } from './design';

interface Bridge {
  saveDesign(json: string, suggested: string): Promise<boolean>;
  openDesign(): Promise<string | null>;
  savePng(dataUrl: string): Promise<boolean>;
}

function bridge(): Bridge | null {
  return ((window as unknown as { thinkabuild?: Bridge }).thinkabuild ?? null) as Bridge | null;
}

export async function saveDesignFile(d: Design): Promise<boolean> {
  const json = JSON.stringify(d, null, 1);
  const name = (d.name || 'design').replace(/[^\w\- ]+/g, '').trim() || 'design';
  const b = bridge();
  if (b) return b.saveDesign(json, `${name}.tab.json`);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = `${name}.tab.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return true;
}

export async function openDesignFile(): Promise<Design | null> {
  const b = bridge();
  let text: string | null = null;
  if (b) text = await b.openDesign();
  else {
    text = await new Promise<string | null>((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.onchange = () => {
        const f = inp.files?.[0];
        if (!f) return resolve(null);
        f.text().then(resolve, () => resolve(null));
      };
      inp.click();
    });
  }
  if (!text) return null;
  try {
    const d = JSON.parse(text) as Design;
    if (d && d.version === 1 && Array.isArray(d.parts)) return d;
  } catch {
    /* invalid */
  }
  return null;
}

export async function saveScreenshot(dataUrl: string): Promise<void> {
  const b = bridge();
  if (b) {
    await b.savePng(dataUrl);
    return;
  }
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = 'thinkabuild.png';
  a.click();
}
