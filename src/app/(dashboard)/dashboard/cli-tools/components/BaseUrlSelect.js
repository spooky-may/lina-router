"use client";

import { useEffect, useMemo, useState } from "react";
import { APP_CONFIG } from "@/shared/constants/config";

const STORAGE_KEY = "9router.cliToolEndpointPresets";
const CUSTOM_VALUE = "__custom__";
const SAVE_VALUE = "__save__";

const ensureV1 = (url) => {
  const trimmed = (url || "").replace(/\/+$/, "");
  if (!trimmed) return "";
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
};

const stripV1 = (url) => (url || "").replace(/\/v1\/?$/, "");

const readSavedPresets = () => {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((p) => p?.name && p?.baseUrl);
  } catch {
    return [];
  }
};

const writeSavedPresets = (presets) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
};

// Build endpoint options ordered by priority
const buildOptions = ({ requiresExternalUrl, tunnelEnabled, tunnelPublicUrl, tailscaleEnabled, tailscaleUrl, savedPresets, withV1 }) => {
  const opts = [];
  const wrap = (url) => (withV1 ? ensureV1(url) : url.replace(/\/+$/, ""));
  if (!requiresExternalUrl) {
    opts.push({ value: "local", label: `Localhost (127.0.0.1)`, url: wrap(`http://127.0.0.1:${APP_CONFIG.appPort}`) });
  }
  if (tunnelEnabled && tunnelPublicUrl) {
    opts.push({ value: "tunnel", label: `Tunnel - ${tunnelPublicUrl}`, url: wrap(tunnelPublicUrl) });
  }
  if (tailscaleEnabled && tailscaleUrl) {
    opts.push({ value: "tailscale", label: `Tailscale - ${tailscaleUrl}`, url: wrap(tailscaleUrl) });
  }
  savedPresets.forEach((p) => {
    opts.push({ value: `saved:${p.name}`, label: `★ ${p.name} - ${p.baseUrl}`, url: p.baseUrl, saved: true });
  });
  opts.push({ value: CUSTOM_VALUE, label: "Custom URL...", url: "" });
  return opts;
};

export default function BaseUrlSelect({
  value,
  onChange,
  requiresExternalUrl = false,
  tunnelEnabled = false,
  tunnelPublicUrl = "",
  tailscaleEnabled = false,
  tailscaleUrl = "",
  withV1 = true,
}) {
  const [savedPresets, setSavedPresets] = useState([]);
  const [mode, setMode] = useState("");

  useEffect(() => {
    setSavedPresets(readSavedPresets());
  }, []);

  const options = useMemo(
    () => buildOptions({ requiresExternalUrl, tunnelEnabled, tunnelPublicUrl, tailscaleEnabled, tailscaleUrl, savedPresets, withV1 }),
    [requiresExternalUrl, tunnelEnabled, tunnelPublicUrl, tailscaleEnabled, tailscaleUrl, savedPresets, withV1]
  );

  // Auto-detect mode based on current value matching an option
  useEffect(() => {
    if (!value) {
      if (options[0] && options[0].value !== CUSTOM_VALUE) {
        setMode(options[0].value);
        onChange(options[0].url);
      }
      return;
    }
    const match = options.find((o) => o.url && o.url === value);
    setMode(match ? match.value : CUSTOM_VALUE);
  }, [value, options]);

  const handleSelect = (e) => {
    const next = e.target.value;
    if (next === SAVE_VALUE) {
      const trimmed = (value || "").trim();
      if (!trimmed) return;
      let defaultName = trimmed;
      try { defaultName = new URL(trimmed).host; } catch {}
      const name = window.prompt("Save endpoint as:", defaultName);
      if (!name?.trim()) return;
      const next = [...savedPresets.filter((p) => p.name !== name.trim()), { name: name.trim(), baseUrl: trimmed }]
        .sort((a, b) => a.name.localeCompare(b.name));
      setSavedPresets(next);
      writeSavedPresets(next);
      return;
    }
    setMode(next);
    if (next === CUSTOM_VALUE) {
      onChange("");
      return;
    }
    const opt = options.find((o) => o.value === next);
    if (opt) onChange(opt.url);
  };

  const handleDeleteSaved = () => {
    if (!mode.startsWith("saved:")) return;
    const name = mode.slice(6);
    const next = savedPresets.filter((p) => p.name !== name);
    setSavedPresets(next);
    writeSavedPresets(next);
    setMode(CUSTOM_VALUE);
  };

  const isSaved = mode.startsWith("saved:");
  const isCustom = mode === CUSTOM_VALUE;
  const canSave = isCustom && (value || "").trim().length > 0;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <select
          value={mode}
          onChange={handleSelect}
          className="flex-1 min-w-0 px-2 py-2 bg-surface rounded text-xs border border-border focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
          {canSave && <option value={SAVE_VALUE}>+ Save current as...</option>}
        </select>
        {isSaved && (
          <button type="button" onClick={handleDeleteSaved} className="p-1 text-text-muted hover:text-red-500 rounded transition-colors shrink-0" title="Delete saved endpoint">
            <span className="material-symbols-outlined text-[14px]">delete</span>
          </button>
        )}
      </div>
      {isCustom && (
        <input
          type="text"
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={withV1 ? "https://example.com/v1" : "https://example.com"}
          className="w-full min-w-0 px-2 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5"
        />
      )}
    </div>
  );
}
