/* Executed only by macOS osascript. No shell, writes, unlocked-note access or database access. */
ObjC.import('Foundation');

function inputJSON() {
  var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  return JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '{}');
}
function foldersIn(account) {
  var stack = account.folders(), found = [], seen = {};
  while (stack.length) {
    if (found.length >= 1000) throw new Error('FOLDER_LIMIT');
    var folder = stack.pop(), id = String(folder.id());
    if (seen['$' + id]) continue;
    seen['$' + id] = true;
    found.push(folder);
    var children = folder.folders();
    for (var i = 0; i < children.length; i++) stack.push(children[i]);
  }
  return found;
}
function run(argv) {
  try {
    var operation = argv[0], args = inputJSON(), current = Application.currentApplication();
    current.includeStandardAdditions = true;
    if (operation === 'choose-files') {
      var picked = current.chooseFolder({ withPrompt: args.locale === 'zh-CN' ? '选择 Unprompted 可以只读观察的文件夹' : 'Choose folders Unprompted may observe read-only', multipleSelectionsAllowed: true });
      if (!Array.isArray(picked)) picked = [picked];
      return JSON.stringify({ ok: true, paths: picked.map(function (item) { return item.toString(); }) });
    }
    var notes = Application('Notes');
    if (operation === 'choose-notes') {
      var accounts = notes.accounts(), choices = [], labels = [];
      if (accounts.length > 30) throw new Error('ACCOUNT_LIMIT');
      for (var ai = 0; ai < accounts.length; ai++) {
        var account = accounts[ai], folders = foldersIn(account);
        for (var fi = 0; fi < folders.length; fi++) {
          var name = String(folders[fi].name()).slice(0, 250);
          if (/^(Recently Deleted|最近删除)$/i.test(name)) continue;
          var choice = { accountId: String(account.id()), folderId: String(folders[fi].id()), accountLabel: String(account.name()).slice(0, 250), label: name };
          choices.push(choice); labels.push(String(choices.length) + '  ' + choice.accountLabel + ' / ' + name);
        }
      }
      if (!choices.length) return JSON.stringify({ ok: false, code: 'NO_FOLDERS' });
      var selected = current.chooseFromList(labels, { withTitle: 'Unprompted', withPrompt: args.locale === 'zh-CN' ? '选择只读观察的备忘录文件夹（可多选）' : 'Choose Notes folders to observe read-only', multipleSelectionsAllowed: true, emptySelectionAllowed: false });
      if (!selected) return JSON.stringify({ ok: false, code: 'CANCELLED' });
      return JSON.stringify({ ok: true, folders: selected.map(function (label) { return choices[labels.indexOf(String(label))]; }) });
    }
    if (operation !== 'read-notes') return JSON.stringify({ ok: false, code: 'UNKNOWN_OPERATION' });
    var records = [], errors = [], complete = true, count = 0, used = 0, seenNotes = {};
    for (var si = 0; si < args.folders.length; si++) {
      var scope = args.folders[si];
      try {
        var selectedAccount = notes.accounts.byId(scope.accountId), candidates = foldersIn(selectedAccount), target = null;
        for (var ci = 0; ci < candidates.length; ci++) if (String(candidates[ci].id()) === scope.folderId) { target = candidates[ci]; break; }
        if (!target) { errors.push({ folderId: scope.folderId, code: 'FOLDER_UNAVAILABLE' }); complete = false; continue; }
        var items = target.notes();
        for (var ni = 0; ni < items.length; ni++) {
          if (++count > 500) { errors.push({ folderId: scope.folderId, code: 'NOTE_LIMIT' }); complete = false; break; }
          var note = items[ni], rawId = String(note.id());
          if (seenNotes['$' + rawId]) continue;
          seenNotes['$' + rawId] = true;
          if (String(note.container().id()) !== scope.folderId) continue;
          var row = { providerId: rawId, folderId: scope.folderId, accountId: scope.accountId };
          if (note.passwordProtected()) { row.unavailable = 'locked'; records.push(row); continue; }
          row.title = String(note.name()).slice(0, 1000);
          row.modifiedAt = note.modificationDate().toISOString(); row.stamp = row.modifiedAt;
          var known = args.known['$' + rawId];
          if (known && known.stamp === row.stamp && !known.unavailable && known.folderId === row.folderId) { row.unchanged = true; records.push(row); continue; }
          var text = String(note.plaintext());
          if (text.length > 512 * 1024) { row.unavailable = 'too_large'; records.push(row); continue; }
          if (used + text.length > 4 * 1024 * 1024) { complete = false; errors.push({ folderId: scope.folderId, code: 'READ_BUDGET' }); break; }
          row.content = text; used += text.length; records.push(row);
        }
      } catch (error) {
        if (error.errorNumber === -1743 || error.number === -1743 || String(error).indexOf('-1743') >= 0) return JSON.stringify({ ok: false, code: 'AUTOMATION_DENIED' });
        complete = false; errors.push({ folderId: scope.folderId, code: 'FOLDER_UNAVAILABLE' });
      }
    }
    return JSON.stringify({ ok: true, records: records, errors: errors, complete: complete });
  } catch (error) {
    var code = error.errorNumber === -128 || error.number === -128 || String(error).indexOf('-128') >= 0 ? 'CANCELLED'
      : error.errorNumber === -1743 || error.number === -1743 || String(error).indexOf('-1743') >= 0 ? 'AUTOMATION_DENIED' : 'NATIVE_ACCESS_FAILED';
    return JSON.stringify({ ok: false, code: code });
  }
}
