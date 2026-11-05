/**
 * Keeps a secret input in sync with browser storage. "Remember" keeps it in localStorage,
 * otherwise it only lives in sessionStorage for the tab. The checkbox starts checked.
 */
export function bindStoredSecret(input, remember, storageKey) {
  try {
    const local = localStorage.getItem(storageKey);
    const stored = local || sessionStorage.getItem(storageKey);

    if (stored) {
      input.value = stored;
      remember.checked = Boolean(local);
    }
  } catch {
    // Storage can be blocked; the field still works for this page load.
  }

  const persist = () => {
    try {
      localStorage.removeItem(storageKey);
      sessionStorage.removeItem(storageKey);

      const value = input.value.trim();
      if (!value) return;

      (remember.checked ? localStorage : sessionStorage).setItem(storageKey, value);
    } catch {
      // Ignore storage failures.
    }
  };

  input.addEventListener("input", persist);
  remember.addEventListener("change", persist);
}
