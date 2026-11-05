// Keep unfinished work in memory across live updates. Nothing is persisted.
function identity(element) {
  if (element.id) return `id:${element.id}`;
  const data = [...element.attributes].filter(attr => attr.name.startsWith('data-') && attr.name !== 'data-idle-label')
    .map(attr => [attr.name, attr.value]).sort(([a], [b]) => a.localeCompare(b));
  const form = element.closest('form');
  const scope = [form && form !== element ? identity(form) : '', element.closest('[data-preserve]')?.dataset.preserve || ''];
  if (data.length || element.name) return JSON.stringify([scope, element.tagName, element.type, element.name, data]);
  if (element.tagName === 'SUMMARY' && element.parentElement?.dataset.preserve) return `summary:${element.parentElement.dataset.preserve}`;
  if (form && element.type === 'submit') return `submit:${JSON.stringify(scope)}`;
  return null;
}

function baseline(element) {
  if (element.tagName === 'SELECT') return [...element.options].filter(option => option.defaultSelected).map(option => option.value).join('\n');
  return element.defaultValue;
}

export function preserveInteraction(root, replace) {
  const active = root.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = active && identity(active);
  const selection = active && typeof active.selectionStart === 'number'
    ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
  const details = new Map([...root.querySelectorAll('details[data-preserve]')].map(node => [node.dataset.preserve, node.open]));
  const drafts = new Map();
  for (const element of root.querySelectorAll('input, textarea, select')) {
    const key = identity(element);
    if (!key) continue;
    if (element.type === 'file') {
      if (element.files?.length) drafts.set(key, { file: element });
    } else if (['checkbox', 'radio'].includes(element.type)) {
      if (element.checked !== element.defaultChecked) drafts.set(key, {
        checked: element.checked, defaultChecked: element.defaultChecked,
        context: element.dataset.preserveContext
      });
    } else if (element.value !== baseline(element) || element === active) {
      drafts.set(key, { value: element.value });
    }
  }
  replace();
  for (const detail of root.querySelectorAll('details[data-preserve]')) {
    if (details.has(detail.dataset.preserve)) detail.open = details.get(detail.dataset.preserve);
  }
  for (const element of root.querySelectorAll('input, textarea, select')) {
    const draft = drafts.get(identity(element));
    if (!draft) continue;
    if (draft.file) {
      if (draft.file.accept === element.accept) element.replaceWith(draft.file);
    } else if (Object.hasOwn(draft, 'checked')) {
      // A new authorization/version or changed server setting starts unchecked.
      if (draft.defaultChecked === element.defaultChecked && draft.context === element.dataset.preserveContext) element.checked = draft.checked;
    } else if (element.tagName !== 'SELECT' || [...element.options].some(option => option.value === draft.value && !option.disabled)) {
      element.value = draft.value;
    }
  }
  // Restore dependent presentation without dispatching events or executing actions.
  for (const form of root.querySelectorAll('[data-wait-form]')) {
    const input = form.querySelector('[data-wait-until]');
    if (input) input.hidden = form.querySelector('[data-wait-kind]')?.value !== 'time';
  }
  for (const checkbox of root.querySelectorAll('[data-patch-confirm]')) {
    const button = [...root.querySelectorAll('[data-patch-apply]')].find(node => node.dataset.patchId === checkbox.dataset.patchConfirm);
    if (button) button.disabled = !checkbox.checked;
  }
  if (focusKey) {
    const matches = [...root.querySelectorAll('button, input, textarea, select, summary, a')].filter(node => identity(node) === focusKey);
    if (matches.length === 1 && !matches[0].disabled) {
      matches[0].focus({ preventScroll: true });
      if (selection) matches[0].setSelectionRange?.(...selection);
    }
  }
}
