import {
  ExternalLink,
  Monitor,
  PanelRightClose,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PreviewService, SkillSummary } from "../src/types.js";
import { SkillsPane } from "./skills-pane.js";
import "./right-panel.css";

type RightPanelTabType = "preview" | "skills";

type RightPanelTab = {
  id: string;
  type: RightPanelTabType;
  title: string;
};

const TAB_TITLES: Record<RightPanelTabType, string> = {
  preview: "Preview",
  skills: "Skills"
};

const initialRightTabs: RightPanelTab[] = [
  { id: "preview-1", type: "preview", title: "Preview" }
];

export function RightPanel({
  previews,
  skills,
  workspaceUrl,
  focusSkill,
  onCollapse,
  onRemovePreview
}: {
  previews: PreviewService[];
  skills: SkillSummary[];
  workspaceUrl: (path: string) => string;
  focusSkill?: { name: string; nonce: number };
  onCollapse: () => void;
  onRemovePreview: (preview: PreviewService) => Promise<void>;
}) {
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | undefined>();
  const [previewRefreshKey, setPreviewRefreshKey] = useState(0);
  const [tabs, setTabs] = useState<RightPanelTab[]>(initialRightTabs);
  const [activeTabId, setActiveTabId] = useState(initialRightTabs[0].id);
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const previousPreviewIds = useRef(new Set<string>());
  const handledFocusNonce = useRef<number | undefined>(undefined);

  const selectedPreview = useMemo(
    () => previews.find((preview) => preview.id === selectedPreviewId) ?? previews[0],
    [selectedPreviewId, previews]
  );
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  useEffect(() => {
    if (previews.length === 0) {
      setSelectedPreviewId(undefined);
      return;
    }
    if (!selectedPreviewId || !previews.some((preview) => preview.id === selectedPreviewId)) {
      setSelectedPreviewId(previews[0].id);
    }
  }, [selectedPreviewId, previews]);

  useEffect(() => {
    const previousIds = previousPreviewIds.current;
    const hasNewPreview = previews.some((preview) => !previousIds.has(preview.id));
    previousPreviewIds.current = new Set(previews.map((preview) => preview.id));
    if (!hasNewPreview) return;

    setSelectedPreviewId(previews[0]?.id);
    const previewTab = tabs.find((tab) => tab.type === "preview");
    if (previewTab) {
      setActiveTabId(previewTab.id);
      return;
    }

    const id = `preview-${Date.now().toString(36)}`;
    setTabs((current) => [...current, { id, type: "preview", title: "Preview" }]);
    setActiveTabId(id);
  }, [previews, tabs]);

  useEffect(() => {
    if (!focusSkill || focusSkill.nonce === handledFocusNonce.current) return;
    handledFocusNonce.current = focusSkill.nonce;
    openTab("skills");
  }, [focusSkill, tabs]);

  function openTab(type: RightPanelTabType) {
    const existing = tabs.find((tab) => tab.type === type);
    if (existing) {
      setActiveTabId(existing.id);
      setNewTabMenuOpen(false);
      return;
    }
    const id = `${type}-${Date.now().toString(36)}`;
    setTabs((current) => [...current, { id, type, title: TAB_TITLES[type] }]);
    setActiveTabId(id);
    setNewTabMenuOpen(false);
  }

  function closeTab(tabId: string) {
    if (tabs.length <= 1) {
      onCollapse();
      return;
    }

    const index = tabs.findIndex((tab) => tab.id === tabId);
    const nextTabs = tabs.filter((tab) => tab.id !== tabId);
    setTabs(nextTabs);
    if (activeTabId === tabId) {
      setActiveTabId(nextTabs[Math.max(0, index - 1)]?.id ?? nextTabs[0].id);
    }
  }

  return (
    <aside className="right-panel">
      <div className="right-tabbar">
        <div className="right-tabs" role="tablist" aria-label="Right panel tabs">
          {tabs.map((tab) => {
            const TabIcon = tab.type === "skills" ? Sparkles : Monitor;
            const count = tab.type === "skills" ? skills.length : previews.length;
            return (
              <div className={tab.id === activeTab?.id ? "right-tab active" : "right-tab"} key={tab.id}>
                <button
                  type="button"
                  className="right-tab-select"
                  onClick={() => setActiveTabId(tab.id)}
                  role="tab"
                  aria-selected={tab.id === activeTab?.id}
                >
                  <TabIcon size={14} />
                  <span>{tab.title}</span>
                  <span className="right-tab-count">{count}</span>
                </button>
                <button type="button" className="right-tab-close" title="Close tab" onClick={() => closeTab(tab.id)}>
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="right-tab-actions">
          <button
            type="button"
            className="panel-icon-button"
            onClick={() => setNewTabMenuOpen((open) => !open)}
            title="New tab"
          >
            <Plus size={16} />
          </button>
          {newTabMenuOpen && (
            <div className="new-tab-menu">
              <button type="button" onClick={() => openTab("preview")}>
                <Monitor size={14} />
                <span>Preview</span>
              </button>
              <button type="button" onClick={() => openTab("skills")}>
                <Sparkles size={14} />
                <span>Skills</span>
              </button>
            </div>
          )}
          <button type="button" className="panel-icon-button" onClick={onCollapse} title="Collapse panel">
            <PanelRightClose size={16} />
          </button>
        </div>
      </div>

      <div className="right-panel-body">
        {activeTab?.type === "skills" ? (
          <SkillsPane skills={skills} workspaceUrl={workspaceUrl} focusSkillName={focusSkill?.name} />
        ) : (
          <PreviewPane
            previews={previews}
            selectedPreview={selectedPreview}
            previewRefreshKey={previewRefreshKey}
            onSelectPreview={setSelectedPreviewId}
            onRefreshPreview={() => setPreviewRefreshKey((key) => key + 1)}
            onRemovePreview={onRemovePreview}
          />
        )}
      </div>
    </aside>
  );
}

function PreviewPane({
  previews,
  selectedPreview,
  previewRefreshKey,
  onSelectPreview,
  onRefreshPreview,
  onRemovePreview
}: {
  previews: PreviewService[];
  selectedPreview: PreviewService | undefined;
  previewRefreshKey: number;
  onSelectPreview: (id: string) => void;
  onRefreshPreview: () => void;
  onRemovePreview: (preview: PreviewService) => Promise<void>;
}) {
  return (
    <section className="preview-pane">
      <div className="pane-toolbar">
        <div className="preview-tabs">
          {previews.length === 0 ? (
            <span className="preview-placeholder">No exposed services.</span>
          ) : (
            previews.map((preview) => (
              <button
                type="button"
                className={preview.id === selectedPreview?.id ? "preview-tab active" : "preview-tab"}
                key={preview.id}
                onClick={() => onSelectPreview(preview.id)}
                title={`${preview.name} :${preview.port}`}
              >
                <span>{preview.name}</span>
                <small>:{preview.port}</small>
              </button>
            ))
          )}
        </div>
        <div className="pane-actions">
          <button
            type="button"
            className="panel-icon-button"
            onClick={onRefreshPreview}
            disabled={!selectedPreview}
            title="Refresh preview"
          >
            <RefreshCw size={15} />
          </button>
          {selectedPreview && (
            <a className="panel-icon-button" href={selectedPreview.path} target="_blank" rel="noreferrer" title="Open preview">
              <ExternalLink size={15} />
            </a>
          )}
          {selectedPreview && (
            <button
              type="button"
              className="panel-icon-button"
              onClick={() => void onRemovePreview(selectedPreview)}
              title="Remove preview"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {previews.length === 0 ? (
        <div className="preview-empty">
          <Monitor size={22} />
          <span>No exposed services.</span>
        </div>
      ) : (
        selectedPreview && (
          <iframe
            className="preview-frame"
            key={`${selectedPreview.id}-${previewRefreshKey}`}
            src={selectedPreview.path}
            title={`Preview ${selectedPreview.name}`}
          />
        )
      )}
    </section>
  );
}
