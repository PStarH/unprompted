/* Executed only by macOS osascript for selected folders and note creation. */
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
    if (operation === 'choose-reminders' || operation === 'read-reminders' || operation === 'create-reminder' || operation === 'change-reminder' || operation === 'delete-reminder') {
      var remindersApp = Application('Reminders'), reminderAccounts = remindersApp.accounts(), reminderLists = [], reminderLabels = [];
      if (reminderAccounts.length > 30) throw new Error('ACCOUNT_LIMIT');
      for (var rai = 0; rai < reminderAccounts.length; rai++) {
        var ra = reminderAccounts[rai], rl = ra.lists();
        if (reminderLists.length + rl.length > 1000) throw new Error('LIST_LIMIT');
        for (var rli = 0; rli < rl.length; rli++) {
          var rchoice = { accountId: String(ra.id()), folderId: String(rl[rli].id()), accountLabel: String(ra.name()).slice(0, 250), label: String(rl[rli].name()).slice(0, 250), target: rl[rli] };
          reminderLists.push(rchoice); reminderLabels.push(String(reminderLists.length) + '  ' + rchoice.accountLabel + ' / ' + rchoice.label);
        }
      }
      if (operation === 'choose-reminders') {
        if (!reminderLists.length) return JSON.stringify({ ok: false, code: 'NO_FOLDERS' });
        var rselected = current.chooseFromList(reminderLabels, { withTitle: 'Unprompted', withPrompt: args.locale === 'zh-CN' ? '选择只读观察的提醒事项列表' : 'Choose Reminders lists to observe read-only', multipleSelectionsAllowed: true, emptySelectionAllowed: false });
        if (!rselected) return JSON.stringify({ ok: false, code: 'CANCELLED' });
        return JSON.stringify({ ok: true, folders: rselected.map(function (label) { var entry = reminderLists[reminderLabels.indexOf(String(label))]; return { accountId: entry.accountId, folderId: entry.folderId, accountLabel: entry.accountLabel, label: entry.label }; }) });
      }
      if (operation === 'create-reminder') {
        if (!args.folder || typeof args.title !== 'string' || !args.title.trim() || args.title.length > 500 || /[\r\n]/.test(args.title)
          || typeof args.body !== 'string' || !args.body.trim() || args.body.length > 64000 || !/^unprompted-artifact:[a-f0-9]{64}$/.test(args.marker)) throw new Error('INVALID_CONTENT');
        var writeList = null;
        for (var rwi = 0; rwi < reminderLists.length; rwi++) if (reminderLists[rwi].accountId === args.folder.accountId && reminderLists[rwi].folderId === args.folder.folderId) writeList = reminderLists[rwi].target;
        if (!writeList) throw new Error('LIST_UNAVAILABLE');
        var newReminder = remindersApp.Reminder({ name: args.title, body: args.body + '\n' + args.marker });
        writeList.reminders.push(newReminder);
        return JSON.stringify({ ok: true, id: String(newReminder.id()) });
      }
      if (operation === 'change-reminder' || operation === 'delete-reminder') {
        if (!args.folder || typeof args.reminderId !== 'string' || !args.reminderId || args.reminderId.length > 4096
          || typeof args.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(args.expectedUpdatedAt))) throw new Error('INVALID_CONTENT');
        var editList = null;
        for (var rei = 0; rei < reminderLists.length; rei++) if (reminderLists[rei].accountId === args.folder.accountId && reminderLists[rei].folderId === args.folder.folderId) editList = reminderLists[rei].target;
        if (!editList) throw new Error('LIST_UNAVAILABLE');
        var candidates = editList.reminders(), editReminder = null;
        if (candidates.length > 500) throw new Error('REMINDER_LIMIT');
        for (var eri = 0; eri < candidates.length; eri++) if (String(candidates[eri].id()) === args.reminderId) { editReminder = candidates[eri]; break; }
        if (!editReminder || editReminder.modificationDate().toISOString() !== args.expectedUpdatedAt) throw new Error('REMINDER_CHANGED');
        if (operation === 'delete-reminder') { editReminder.delete(); return JSON.stringify({ ok: true, id: args.reminderId }); }
        var changes = args.changes, own = function (key) { return Object.prototype.hasOwnProperty.call(changes, key); };
        if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length
          || Object.keys(changes).some(function (key) { return ['title', 'body', 'completed', 'dueAt'].indexOf(key) < 0; })
          || own('title') && (typeof changes.title !== 'string' || !changes.title.trim() || changes.title.length > 500 || /[\r\n]/.test(changes.title))
          || own('body') && (typeof changes.body !== 'string' || changes.body.length > 64000)
          || own('completed') && typeof changes.completed !== 'boolean'
          || own('dueAt') && (typeof changes.dueAt !== 'string' || !Number.isFinite(Date.parse(changes.dueAt)))) throw new Error('INVALID_CONTENT');
        if (own('title')) editReminder.name = changes.title;
        if (own('body')) editReminder.body = changes.body;
        if (own('completed')) editReminder.completed = changes.completed;
        if (own('dueAt')) editReminder.dueDate = new Date(changes.dueAt);
        return JSON.stringify({ ok: true, id: args.reminderId });
      }
      var reminderRecords = [], reminderErrors = [], reminderComplete = true, reminderCount = 0, reminderUsed = 0;
      for (var rsi = 0; rsi < args.folders.length; rsi++) {
        var rs = args.folders[rsi], rt = null;
        for (var rci = 0; rci < reminderLists.length; rci++) if (reminderLists[rci].accountId === rs.accountId && reminderLists[rci].folderId === rs.folderId) rt = reminderLists[rci];
        if (!rt) { reminderComplete = false; reminderErrors.push({ code: 'LIST_UNAVAILABLE' }); continue; }
        try {
          var ris = rt.target.reminders();
          for (var rii = 0; rii < ris.length; rii++) {
            if (++reminderCount > 500) { reminderComplete = false; reminderErrors.push({ code: 'REMINDER_LIMIT' }); break; }
            var ri = ris[rii], rb = String(ri.body() || ''), rn = String(ri.name() || '');
            if (rb.length > 512 * 1024 || (reminderUsed += rb.length + rn.length) > 4 * 1024 * 1024) { reminderComplete = false; reminderErrors.push({ code: 'READ_BUDGET' }); break; }
            var rd = ri.dueDate();
            reminderRecords.push({ id: String(ri.id()), title: rn, body: rb, updatedAt: ri.modificationDate().toISOString(), state: ri.completed() ? 'closed' : 'open', dueAt: rd ? rd.toISOString() : null, list: rt.label, accountId: rs.accountId, folderId: rs.folderId });
          }
        } catch (reminderError) {
          if (reminderError.errorNumber === -1743 || reminderError.number === -1743) throw reminderError;
          reminderComplete = false; reminderErrors.push({ code: 'LIST_UNAVAILABLE' });
        }
      }
      return JSON.stringify({ ok: true, records: reminderRecords, errors: reminderErrors, complete: reminderComplete });
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
    if (operation === 'create-note') {
      if (!args.folder || typeof args.title !== 'string' || !args.title.trim() || args.title.length > 500 || /[\r\n]/.test(args.title)
        || typeof args.body !== 'string' || !args.body.trim() || args.body.length > 64000 || !/^unprompted-artifact:[a-f0-9]{64}$/.test(args.marker)) throw new Error('INVALID_CONTENT');
      var writeAccount = notes.accounts.byId(args.folder.accountId), writeFolders = foldersIn(writeAccount), writeFolder = null;
      for (var wi = 0; wi < writeFolders.length; wi++) if (String(writeFolders[wi].id()) === args.folder.folderId) { writeFolder = writeFolders[wi]; break; }
      if (!writeFolder) throw new Error('FOLDER_UNAVAILABLE');
      function htmlText(value) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r\n?|\n/g, '<br>'); }
      var createdNote = notes.Note({ body: '<div>' + htmlText(args.title) + '</div><div>' + htmlText(args.body) + '</div><div>' + args.marker + '</div>' });
      writeFolder.notes.push(createdNote);
      return JSON.stringify({ ok: true, id: String(createdNote.id()) });
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
