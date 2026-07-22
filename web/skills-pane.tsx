import { ChevronLeft, FilePlus2, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import React, { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { SkillFileEntry, SkillSummary } from "../src/types.js";
import { readError, readJsonResponse, readResponseError } from "./http.js";

const CodeEditor = React.lazy(() => import("./code-editor.js"));

export function SkillsPane({
  skills,
  workspaceUrl,
  focusSkillName
}: {
  skills: SkillSummary[];
  workspaceUrl: (path: string) => string;
  focusSkillName?: string;
}) {
  const [selectedSkillName, setSelectedSkillName] = useState<string | undefined>();
  const [files, setFiles] = useState<SkillFileEntry[]>([]);
  const [selectedFilePath, setSelectedFilePath] = useState<string | undefined>();
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [newSkillOpen, setNewSkillOpen] = useState(false);
  const [newSkillName, setNewSkillName] = useState("");
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFileName, setNewFileName] = useState("");

  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.name === selectedSkillName),
    [skills, selectedSkillName]
  );
  const dirty = content !== savedContent;

  useEffect(() => {
    if (focusSkillName) setSelectedSkillName(focusSkillName);
  }, [focusSkillName]);

  const loadFiles = useCallback(
    async (skill: SkillSummary, preferredPath?: string) => {
      const response = await fetch(
        `${workspaceUrl("/skills/files")}?baseDir=${encodeURIComponent(skill.baseDir)}`
      );
      if (!response.ok) throw new Error(await readResponseError(response));
      const payload = (await readJsonResponse(response)) as { files: SkillFileEntry[] };
      setFiles(payload.files);
      const next =
        payload.files.find((file) => file.path === preferredPath) ??
        payload.files.find((file) => file.path === skill.filePath) ??
        payload.files[0];
      setSelectedFilePath(next?.path);
    },
    [workspaceUrl]
  );

  useEffect(() => {
    setFiles([]);
    setSelectedFilePath(undefined);
    setContent("");
    setSavedContent("");
    setError(undefined);
    setNewFileOpen(false);
    if (!selectedSkill) return;
    loadFiles(selectedSkill).catch((err) => setError(readError(err)));
  }, [selectedSkill?.baseDir, loadFiles]);

  useEffect(() => {
    setContent("");
    setSavedContent("");
    if (!selectedFilePath) return;
    let cancelled = false;
    fetch(`${workspaceUrl("/skills/file")}?path=${encodeURIComponent(selectedFilePath)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(await readResponseError(response));
        const payload = (await response.json()) as { content: string };
        if (cancelled) return;
        setContent(payload.content);
        setSavedContent(payload.content);
        setError(undefined);
      })
      .catch((err) => {
        if (!cancelled) setError(readError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFilePath, workspaceUrl]);

  async function save() {
    if (!selectedFilePath) return;
    setBusy(true);
    try {
      const response = await fetch(workspaceUrl("/skills/file"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedFilePath, content })
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      setSavedContent(content);
      setError(undefined);
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  async function createSkill() {
    const name = newSkillName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const response = await fetch(workspaceUrl("/skills"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      setNewSkillOpen(false);
      setNewSkillName("");
      setSelectedSkillName(slugify(name));
      setError(undefined);
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  async function createFile() {
    const name = newFileName.trim().replaceAll(/^\/+/g, "");
    if (!name || !selectedSkill) return;
    if (leaveUnsaved()) return;
    setBusy(true);
    try {
      const path = `${selectedSkill.baseDir}/${name}`;
      const response = await fetch(workspaceUrl("/skills/file"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content: "" })
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      setNewFileOpen(false);
      setNewFileName("");
      await loadFiles(selectedSkill, path);
      setError(undefined);
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeSkill() {
    if (!selectedSkill) return;
    if (!window.confirm(`Delete the skill "${selectedSkill.name}" and all of its files?`)) return;
    setBusy(true);
    try {
      const response = await fetch(
        `${workspaceUrl("/skills")}?baseDir=${encodeURIComponent(selectedSkill.baseDir)}`,
        { method: "DELETE" }
      );
      if (!response.ok) throw new Error(await readResponseError(response));
      setSelectedSkillName(undefined);
      setError(undefined);
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  function leaveUnsaved(): boolean {
    return dirty && !window.confirm("Discard unsaved changes?");
  }

  if (!selectedSkill) {
    return (
      <section className="skills-pane">
        <div className="pane-toolbar">
          <span className="preview-placeholder">
            {skills.length === 0 ? "No skills yet." : `${skills.length} skill${skills.length === 1 ? "" : "s"}`}
          </span>
          <div className="pane-actions">
            <button
              type="button"
              className="panel-icon-button"
              title="New skill"
              onClick={() => setNewSkillOpen((open) => !open)}
            >
              <Plus size={15} />
            </button>
          </div>
        </div>

        {newSkillOpen && (
          <form
            className="skill-new-form"
            onSubmit={(event) => {
              event.preventDefault();
              void createSkill();
            }}
          >
            <input
              autoFocus
              value={newSkillName}
              placeholder="skill-name"
              onChange={(event) => setNewSkillName(event.target.value)}
            />
            <button type="submit" disabled={busy || !newSkillName.trim()}>
              Create
            </button>
          </form>
        )}

        {error && <div className="composer-error">{error}</div>}

        {skills.length === 0 ? (
          <div className="preview-empty">
            <Sparkles size={22} />
            <span>No skills yet.</span>
            <small>Create one, or ask the agent to make a skill.</small>
          </div>
        ) : (
          <div className="skill-list">
            {skills.map((skill) => (
              <button
                type="button"
                className="skill-row"
                key={`${skill.source}-${skill.name}`}
                onClick={() => setSelectedSkillName(skill.name)}
              >
                <Sparkles size={15} className="skill-row-icon" />
                <span className="skill-row-text">
                  <strong>{skill.name}</strong>
                  <small>{skill.description}</small>
                </span>
                <span className={`skill-badge ${skill.source}`}>{skill.source}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="skills-pane">
      <div className="pane-toolbar">
        <div className="skill-detail-head">
          <button
            type="button"
            className="panel-icon-button"
            title="All skills"
            onClick={() => {
              if (leaveUnsaved()) return;
              setSelectedSkillName(undefined);
            }}
          >
            <ChevronLeft size={15} />
          </button>
          <strong className="skill-detail-name">{selectedSkill.name}</strong>
          <span className={`skill-badge ${selectedSkill.source}`}>{selectedSkill.source}</span>
        </div>
        <div className="pane-actions">
          <button
            type="button"
            className="panel-icon-button"
            title="New file"
            onClick={() => setNewFileOpen((open) => !open)}
          >
            <FilePlus2 size={14} />
          </button>
          <button type="button" className="panel-icon-button" title="Delete skill" disabled={busy} onClick={() => void removeSkill()}>
            <Trash2 size={14} />
          </button>
          <button
            type="button"
            className={dirty ? "skill-save dirty" : "skill-save"}
            disabled={busy || !dirty || !selectedFilePath}
            onClick={() => void save()}
          >
            <Save size={14} />
            <span>{dirty ? "Save" : "Saved"}</span>
          </button>
        </div>
      </div>

      {newFileOpen && (
        <form
          className="skill-new-form"
          onSubmit={(event) => {
            event.preventDefault();
            void createFile();
          }}
        >
          <input
            autoFocus
            value={newFileName}
            placeholder="scripts/example.sh"
            onChange={(event) => setNewFileName(event.target.value)}
          />
          <button type="submit" disabled={busy || !newFileName.trim()}>
            Add
          </button>
        </form>
      )}

      {error && <div className="composer-error">{error}</div>}

      <div className="skill-file-tabs">
        {files.map((file) => {
          const label = file.path.startsWith(`${selectedSkill.baseDir}/`)
            ? file.path.slice(selectedSkill.baseDir.length + 1)
            : file.path;
          return (
            <button
              type="button"
              className={file.path === selectedFilePath ? "preview-tab active" : "preview-tab"}
              key={file.path}
              title={label}
              onClick={() => {
                if (file.path === selectedFilePath || leaveUnsaved()) return;
                setSelectedFilePath(file.path);
              }}
            >
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      <div className="skill-editor-wrap">
        {selectedFilePath ? (
          <Suspense fallback={<div className="skill-editor-loading">Loading editor…</div>}>
            <CodeEditor path={selectedFilePath} value={content} onChange={setContent} />
          </Suspense>
        ) : (
          <div className="skill-editor-loading">No file selected.</div>
        )}
      </div>
    </section>
  );
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "");
}
