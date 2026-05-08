import { Copy, Plus, Trash2 } from 'lucide-react'
import {
  usePostProcessorStore,
  type PostProcessorProfile,
  type CommentStyle,
} from '../store/postProcessorStore'

const inputCls =
  'w-full bg-neutral-800 border border-neutral-600 rounded px-2 py-1 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500'

const textareaCls =
  'w-full bg-neutral-800 border border-neutral-600 rounded px-2 py-1.5 text-xs text-neutral-200 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y min-h-[64px]'

const labelCls = 'block text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-1'

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      {hint && <p className="text-[10px] text-neutral-600 mb-1">{hint}</p>}
      {children}
    </div>
  )
}

function ProfileEditor({ profile }: { profile: PostProcessorProfile }) {
  const { updateProfile } = usePostProcessorStore()
  const up = (updates: Partial<Omit<PostProcessorProfile, 'id'>>) =>
    updateProfile(profile.id, updates)

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Name + meta */}
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-1">
          <Field label="Name">
            <input
              type="text"
              value={profile.name}
              onChange={(e) => up({ name: e.target.value })}
              className={inputCls}
            />
          </Field>
        </div>
        <div>
          <Field label="Unit mode">
            <select
              value={profile.unitMode}
              onChange={(e) => up({ unitMode: e.target.value as 'mm' | 'in' })}
              className={inputCls + ' bg-neutral-800'}
            >
              <option value="mm">mm</option>
              <option value="in">inches</option>
            </select>
          </Field>
        </div>
        <div>
          <Field label="Comment style">
            <select
              value={profile.commentStyle}
              onChange={(e) => up({ commentStyle: e.target.value as CommentStyle })}
              className={inputCls + ' bg-neutral-800'}
            >
              <option value="semicolon">; Semicolon</option>
              <option value="parenthesis">( Parenthesis )</option>
              <option value="none">None</option>
            </select>
          </Field>
        </div>
      </div>

      {/* Start / End G-code */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start G-code" hint="Emitted once at job start">
          <textarea
            value={profile.startGcode}
            onChange={(e) => up({ startGcode: e.target.value })}
            className={textareaCls}
            rows={4}
          />
        </Field>
        <Field label="End G-code" hint="Emitted once at job end">
          <textarea
            value={profile.endGcode}
            onChange={(e) => up({ endGcode: e.target.value })}
            className={textareaCls}
            rows={4}
          />
        </Field>
      </div>

      {/* Tool change */}
      <Field label="Tool change G-code" hint="Emitted before each new tool">
        <textarea
          value={profile.toolChangeGcode}
          onChange={(e) => up({ toolChangeGcode: e.target.value })}
          className={textareaCls}
          rows={2}
        />
      </Field>

      {/* Spindle */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Spindle on" hint="Placeholders: {s} = spindle speed">
          <input
            type="text"
            value={profile.spindleOnTemplate}
            onChange={(e) => up({ spindleOnTemplate: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="Spindle off">
          <input
            type="text"
            value={profile.spindleOffGcode}
            onChange={(e) => up({ spindleOffGcode: e.target.value })}
            className={inputCls}
          />
        </Field>
      </div>

      {/* Motion */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Rapid move" hint="Placeholders: {x} {y} {z}">
          <input
            type="text"
            value={profile.rapidTemplate}
            onChange={(e) => up({ rapidTemplate: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="Cut move" hint="Placeholders: {x} {y} {z} {f}">
          <input
            type="text"
            value={profile.cutTemplate}
            onChange={(e) => up({ cutTemplate: e.target.value })}
            className={inputCls}
          />
        </Field>
      </div>

      {/* Arc output */}
      <div>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={profile.outputArcs}
            onChange={(e) => up({ outputArcs: e.target.checked })}
            className="accent-blue-500"
          />
          <span className="text-xs text-neutral-300">Output arc moves (G2/G3)</span>
        </label>
      </div>

      {profile.outputArcs && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Arc CW (G2)" hint="{x} {y} {i} {j} {f}">
            <input
              type="text"
              value={profile.arcCWTemplate}
              onChange={(e) => up({ arcCWTemplate: e.target.value })}
              className={inputCls}
            />
          </Field>
          <Field label="Arc CCW (G3)" hint="{x} {y} {i} {j} {f}">
            <input
              type="text"
              value={profile.arcCCWTemplate}
              onChange={(e) => up({ arcCCWTemplate: e.target.value })}
              className={inputCls}
            />
          </Field>
        </div>
      )}
    </div>
  )
}

export default function PostProcessorPanel() {
  const {
    profiles, activeId,
    setActiveId, addProfile, duplicateProfile, deleteProfile,
  } = usePostProcessorStore()
  const active = profiles.find((p) => p.id === activeId) ?? profiles[0]

  return (
    <div className="flex h-full bg-neutral-900">
      {/* Profile list sidebar */}
      <div className="w-52 flex flex-col flex-shrink-0 border-r border-neutral-700">
        <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-700 flex-shrink-0">
          <span className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">
            Profiles
          </span>
          <div className="flex gap-1">
            <button
              onClick={addProfile}
              title="New profile"
              className="p-0.5 rounded text-neutral-500 hover:text-neutral-300 hover:bg-neutral-700 transition-colors"
            >
              <Plus size={13} />
            </button>
            <button
              onClick={() => duplicateProfile(activeId)}
              title="Duplicate profile"
              className="p-0.5 rounded text-neutral-500 hover:text-neutral-300 hover:bg-neutral-700 transition-colors"
            >
              <Copy size={13} />
            </button>
            <button
              onClick={() => deleteProfile(activeId)}
              disabled={profiles.length <= 1}
              title={profiles.length <= 1 ? 'Cannot delete the last profile' : 'Delete profile'}
              className="p-0.5 rounded text-neutral-500 hover:text-red-400 hover:bg-red-900/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {profiles.map((p) => (
            <button
              key={p.id}
              onClick={() => setActiveId(p.id)}
              className={[
                'w-full text-left px-3 py-2 text-xs transition-colors',
                p.id === activeId
                  ? 'bg-blue-600/20 text-blue-300 border-r-2 border-blue-500'
                  : 'text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100',
              ].join(' ')}
            >
              <div className="font-medium truncate">{p.name}</div>
              <div className="text-[10px] text-neutral-500 mt-0.5">{p.unitMode}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-700 flex-shrink-0">
          <span className="text-xs font-semibold text-neutral-300">{active.name}</span>
          <span className="text-[10px] text-neutral-500">
            Placeholders: {'{x}'} {'{y}'} {'{z}'} {'{f}'} {'{s}'}
          </span>
        </div>
        <ProfileEditor profile={active} />
      </div>
    </div>
  )
}
