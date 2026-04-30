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
  const onCommitRef = useRef(onCommit);
  const isApplyingValueRef = useRef(false);

  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

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
      if (isApplyingValueRef.current) {
        return;
      }
      const next = tagify.value
        .map((entry: TagifyTagData) => String(entry.value).trim())
        .filter((entry) => entry.length > 0);
      onCommitRef.current(next);
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
      isApplyingValueRef.current = true;
      tagifyRef.current.loadOriginalValues(value);
      isApplyingValueRef.current = false;
    }
  }, [value]);

  return <input ref={inputRef} placeholder={placeholder} />;
}
