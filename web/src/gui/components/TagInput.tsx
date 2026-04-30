import React, { useEffect, useRef } from "react";
import Tagify, { type TagifyTagData } from "@yaireo/tagify";
import "@yaireo/tagify/dist/tagify.css";

interface TagInputProps {
  value: string[];
  suggestions: string[];
  placeholder?: string;
  onCommit: (next: string[]) => void;
}

export function TagInput({ value, suggestions, placeholder, onCommit }: TagInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const tagifyRef = useRef<Tagify | null>(null);

  useEffect(() => {
    if (!inputRef.current) {
      return;
    }
    const tagify = new Tagify(inputRef.current, {
      whitelist: suggestions,
      dropdown: { enabled: 0, maxItems: 20 },
      enforceWhitelist: false,
    });
    tagifyRef.current = tagify;
    tagify.loadOriginalValues(value);
    tagify.on("change", () => {
      const next = tagify.value
        .map((entry: TagifyTagData) => String(entry.value).trim())
        .filter((entry) => entry.length > 0);
      onCommit(next);
    });
    return () => {
      tagify.destroy();
      tagifyRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!tagifyRef.current) {
      return;
    }
    tagifyRef.current.settings.whitelist = suggestions;
  }, [suggestions]);

  useEffect(() => {
    if (!tagifyRef.current) {
      return;
    }
    const current = tagifyRef.current.value.map((entry: TagifyTagData) => String(entry.value));
    if (JSON.stringify(current) !== JSON.stringify(value)) {
      tagifyRef.current.loadOriginalValues(value);
    }
  }, [value]);

  return <input ref={inputRef} placeholder={placeholder} />;
}
