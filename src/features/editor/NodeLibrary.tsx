import { useMemo, useState, type RefObject } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Search } from 'lucide-react';
import { NODE_DEFS } from '@/core/nodeRegistry';
import type { NodeType } from '@/core/types';
import { Input } from '@/components/ui';
import { useEditor } from './editorContext';
import { DND_MIME } from './Canvas';
import { PORT_COLORS } from './nodes/ImaginariumNode';

const CATEGORIES = ['Inputs', 'AI', 'Review & output'] as const;

export function NodeLibrary({ canvasRef }: { canvasRef: RefObject<HTMLDivElement | null> }) {
  const { editor, canEdit, userId, select } = useEditor();
  const { screenToFlowPosition } = useReactFlow();
  const [q, setQ] = useState('');

  const defs = useMemo(() => {
    const t = q.trim().toLowerCase();
    return Object.values(NODE_DEFS).filter(
      (d) => !t || d.label.toLowerCase().includes(t) || d.description.toLowerCase().includes(t) || d.keywords.some((k) => k.includes(t)),
    );
  }, [q]);

  const addAtCenter = (type: NodeType) => {
    const r = canvasRef.current?.getBoundingClientRect();
    const pos = r ? screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 0, y: 0 };
    const jitter = () => Math.round(Math.random() * 40 - 20);
    const n = editor.addNode(type, { x: Math.round(pos.x - 130) + jitter(), y: Math.round(pos.y - 60) + jitter() }, userId);
    select(n.id);
  };

  return (
    <aside className="flex h-full flex-col border-r border-line bg-ink">
      <div className="border-b border-line p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mute" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search nodes" className="h-8 pl-8 text-[13px]" aria-label="Search node library" />
        </div>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        {CATEGORIES.map((cat) => {
          const list = defs.filter((d) => d.category === cat);
          if (!list.length) return null;
          return (
            <div key={cat} className="space-y-1.5">
              <div className="label-mono px-1">{cat}</div>
              {list.map((d) => (
                <button
                  key={d.type}
                  draggable={canEdit}
                  disabled={!canEdit}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DND_MIME, d.type);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => addAtCenter(d.type)}
                  className="group w-full rounded-lg border border-line bg-panel px-2.5 py-2 text-left transition hover:border-line-2 hover:bg-raised disabled:opacity-50"
                  title={d.description}
                >
                  <div className="flex items-center gap-2">
                    <span className="size-1.5 rounded-full" style={{ background: d.accent }} />
                    <span className="text-[13px] font-medium">{d.label}</span>
                    <span className="ml-auto flex gap-0.5">
                      {d.outputs.map((p) => (
                        <span key={p.id} className="size-1.5 rounded-full" style={{ background: PORT_COLORS[p.type] }} />
                      ))}
                    </span>
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-mute group-hover:text-soft">{d.description}</div>
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <div className="border-t border-line p-3 text-[10.5px] leading-relaxed text-mute">
        Drag onto the canvas or click to add. Connect matching coloured ports.
      </div>
    </aside>
  );
}
