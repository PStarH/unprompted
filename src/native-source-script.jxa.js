/* Executed only by macOS osascript for selected folders, calendars, mailboxes, contacts, and note creation. */
ObjC.import('Foundation');

function inputJSON() {
  var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  return JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '{}');
}
function automationDenied(error) {
  var text = String(error || '');
  return error && (error.errorNumber === -1743 || error.number === -1743 || text.indexOf('-1743') >= 0 || text.indexOf('Not authorized') >= 0 || text.indexOf('not authorized') >= 0 || text.indexOf('不允许') >= 0);
}
function isoDate(value) {
  if (!value) return null;
  try { return value.toISOString(); } catch (error) { return null; }
}
function clip(value, max) { return String(value || '').slice(0, max); }
function chooseEntries(current, labels, prompt) {
  if (!labels.length) return JSON.stringify({ ok: false, code: 'NO_FOLDERS' });
  var selected = current.chooseFromList(labels, { withTitle: 'Unprompted', withPrompt: prompt, multipleSelectionsAllowed: true, emptySelectionAllowed: false });
  if (!selected) return JSON.stringify({ ok: false, code: 'CANCELLED' });
  return selected;
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
    if (operation === 'choose-calendar' || operation === 'read-calendar') {
      var calendarApp = Application('Calendar'), calendars = calendarApp.calendars(), calendarChoices = [], calendarLabels = [];
      if (calendars.length > 200) throw new Error('CALENDAR_LIMIT');
      for (var cai = 0; cai < calendars.length; cai++) {
        var calendarName = clip(calendars[cai].name(), 250), calendarChoice = { accountId: 'calendar', folderId: String(calendars[cai].id()), accountLabel: 'Calendar', label: calendarName, target: calendars[cai] };
        calendarChoices.push(calendarChoice); calendarLabels.push(String(calendarChoices.length) + '  ' + calendarName);
      }
      if (operation === 'choose-calendar') {
        var calendarSelected = chooseEntries(current, calendarLabels, args.locale === 'zh-CN' ? '选择只读观察的日历（可多选）' : 'Choose calendars to observe read-only');
        if (typeof calendarSelected === 'string') return calendarSelected;
        return JSON.stringify({ ok: true, folders: calendarSelected.map(function (label) { var entry = calendarChoices[calendarLabels.indexOf(String(label))]; return { accountId: entry.accountId, folderId: entry.folderId, accountLabel: entry.accountLabel, label: entry.label }; }) });
      }
      var windowStart = new Date(args.window && args.window.start), windowEnd = new Date(args.window && args.window.end);
      if (!isFinite(windowStart.getTime()) || !isFinite(windowEnd.getTime()) || windowEnd <= windowStart) throw new Error('INVALID_WINDOW');
      var calendarRecords = [], calendarErrors = [], calendarComplete = true, calendarCount = 0;
      for (var cri = 0; cri < args.folders.length; cri++) {
        var calendarScope = args.folders[cri], calendarTarget = null;
        for (var cfi = 0; cfi < calendarChoices.length; cfi++) if (calendarChoices[cfi].folderId === calendarScope.folderId && calendarChoices[cfi].accountId === calendarScope.accountId) calendarTarget = calendarChoices[cfi];
        if (!calendarTarget) { calendarComplete = false; calendarErrors.push({ folderId: calendarScope.folderId, code: 'CALENDAR_UNAVAILABLE' }); continue; }
        try {
          var calendarEvents = calendarTarget.target.events.whose({ _and: [{ startDate: { _lessThan: windowEnd } }, { endDate: { _greaterThan: windowStart } }] })();
          if (calendarEvents.length > 200) { calendarComplete = false; calendarEvents = calendarEvents.slice(0, 200); }
          for (var cei = 0; cei < calendarEvents.length; cei++) {
            if (++calendarCount > 500) { calendarComplete = false; calendarErrors.push({ code: 'EVENT_LIMIT' }); break; }
            var calendarEvent = calendarEvents[cei], eventStart = isoDate(calendarEvent.startDate()), eventEnd = isoDate(calendarEvent.endDate()), eventUpdated = isoDate(calendarEvent.modificationDate());
            if (!eventStart || !eventEnd) { calendarComplete = false; continue; }
            var rawStatus = clip(calendarEvent.status() || 'none', 40).toLowerCase();
            var eventStatus = rawStatus === 'confirmed' || rawStatus === 'tentative' || rawStatus === 'cancelled' || rawStatus === 'none' ? rawStatus : rawStatus.indexOf('cancel') >= 0 ? 'cancelled' : 'none';
            calendarRecords.push({ id: clip(calendarEvent.uid() || calendarEvent.id(), 4096), title: clip(calendarEvent.summary() || '(Untitled event)', 500), description: clip(calendarEvent.description(), 8000), location: clip(calendarEvent.location(), 500), start: eventStart, end: eventEnd, updatedAt: eventUpdated || eventStart, allDay: calendarEvent.alldayEvent() === true, status: eventStatus, accountId: calendarScope.accountId, folderId: calendarScope.folderId, calendar: calendarTarget.label });
          }
        } catch (calendarError) {
          if (automationDenied(calendarError)) throw calendarError;
          calendarComplete = false; calendarErrors.push({ folderId: calendarScope.folderId, code: 'CALENDAR_UNAVAILABLE' });
        }
      }
      return JSON.stringify({ ok: true, records: calendarRecords, errors: calendarErrors, complete: calendarComplete });
    }
    if (operation === 'choose-mail' || operation === 'read-mail') {
      var mailApp = Application('Mail'), mailAccounts = mailApp.accounts(), mailboxes = [], mailboxLabels = [];
      if (mailAccounts.length > 30) throw new Error('ACCOUNT_LIMIT');
      for (var mai = 0; mai < mailAccounts.length; mai++) {
        var mailAccount = mailAccounts[mai], mailStack = mailAccount.mailboxes(), mailAddress = '', seenMail = {};
        try { var addresses = mailAccount.emailAddresses(); if (addresses && addresses.length) mailAddress = clip(addresses[0], 320); } catch (addressError) { if (automationDenied(addressError)) throw addressError; }
        while (mailStack.length) {
          if (mailboxes.length >= 500) throw new Error('MAILBOX_LIMIT');
          var mailbox = mailStack.pop(), mailboxId = String(mailbox.id());
          if (seenMail['$' + mailboxId]) continue;
          seenMail['$' + mailboxId] = true;
          var mailboxName = clip(mailbox.name(), 250);
          mailboxes.push({ accountId: String(mailAccount.id()), folderId: String(mailbox.id()), accountLabel: clip(mailAccount.name(), 250), label: mailboxName, accountEmail: mailAddress, target: mailbox });
          mailboxLabels.push(String(mailboxes.length) + '  ' + clip(mailAccount.name(), 250) + ' / ' + mailboxName);
          var nested = [];
          try { nested = mailbox.mailboxes() || []; } catch (nestedError) { if (automationDenied(nestedError)) throw nestedError; }
          for (var nmi = 0; nmi < nested.length; nmi++) mailStack.push(nested[nmi]);
        }
      }
      if (operation === 'choose-mail') {
        var mailSelected = chooseEntries(current, mailboxLabels, args.locale === 'zh-CN' ? '选择只读观察的邮箱（可多选，含各账号）' : 'Choose mailboxes to observe read-only, across accounts');
        if (typeof mailSelected === 'string') return mailSelected;
        return JSON.stringify({ ok: true, folders: mailSelected.map(function (label) { var entry = mailboxes[mailboxLabels.indexOf(String(label))]; var plain = { accountId: entry.accountId, folderId: entry.folderId, accountLabel: entry.accountLabel, label: entry.label }; if (entry.accountEmail) plain.accountEmail = entry.accountEmail; return plain; }) });
      }
      var mailSince = new Date(args.window && args.window.since);
      if (!isFinite(mailSince.getTime())) throw new Error('INVALID_WINDOW');
      var mailRecords = [], mailErrors = [], mailComplete = true, mailCount = 0;
      var recipientAddresses = function (value) {
        var list = [];
        try { list = value() || []; } catch (recipientError) { if (automationDenied(recipientError)) throw recipientError; return null; }
        var found = [];
        for (var ri = 0; ri < list.length && found.length < 50; ri++) { try { var address = clip(list[ri].address(), 320); if (address) found.push(address); } catch (itemError) { if (automationDenied(itemError)) throw itemError; } }
        return found;
      };
      for (var msi = 0; msi < args.folders.length; msi++) {
        var mailScope = args.folders[msi], mailTarget = null;
        for (var mfi = 0; mfi < mailboxes.length; mfi++) if (mailboxes[mfi].accountId === mailScope.accountId && mailboxes[mfi].folderId === mailScope.folderId) mailTarget = mailboxes[mfi];
        if (!mailTarget) { mailComplete = false; mailErrors.push({ folderId: mailScope.folderId, code: 'MAILBOX_UNAVAILABLE' }); continue; }
        try {
          var matched = mailTarget.target.messages.whose({ dateReceived: { _greaterThanEquals: mailSince } })();
          if (matched.length > 5000) { mailComplete = false; matched = matched.slice(0, 5000); }
          matched.sort(function (left, right) { return right.dateReceived() - left.dateReceived(); });
          if (matched.length > 40) { mailComplete = false; matched = matched.slice(0, 40); }
          for (var mii = 0; mii < matched.length; mii++) {
            if (++mailCount > 200) { mailComplete = false; mailErrors.push({ code: 'MESSAGE_LIMIT' }); break; }
            var mailMessage = matched[mii], receivedAt = isoDate(mailMessage.dateReceived()), sender = clip(mailMessage.sender(), 500);
            if (!receivedAt || !sender) { mailComplete = false; continue; }
            var messageId = clip(mailMessage.messageId() || mailMessage.id(), 4096);
            mailRecords.push({ id: messageId, threadId: messageId, from: sender, to: recipientAddresses(mailMessage.toRecipients), cc: recipientAddresses(mailMessage.ccRecipients), subject: clip(mailMessage.subject() || '(no subject)', 500), body: clip(mailMessage.content(), 24000) || '(no message body)', receivedAt: receivedAt, updatedAt: isoDate(mailMessage.dateSent()) || receivedAt, accountId: mailScope.accountId, folderId: mailScope.folderId, accountEmail: mailTarget.accountEmail || '', mailbox: mailTarget.label });
          }
        } catch (mailError) {
          if (automationDenied(mailError)) throw mailError;
          mailComplete = false; mailErrors.push({ folderId: mailScope.folderId, code: 'MAILBOX_UNAVAILABLE' });
        }
      }
      return JSON.stringify({ ok: true, records: mailRecords, errors: mailErrors, complete: mailComplete });
    }
    if (operation === 'choose-contacts' || operation === 'read-contacts' || operation === 'lookup-contacts') {
      var contactsApp = Application('Contacts'), contactGroups = contactsApp.groups(), contactChoices = [{ accountId: 'contacts', folderId: 'all', accountLabel: 'Contacts', label: args.locale === 'zh-CN' ? '全部联系人' : 'All Contacts', target: null }], contactLabels = ['1  ' + contactChoices[0].label];
      if (contactGroups.length > 200) throw new Error('GROUP_LIMIT');
      for (var cgi = 0; cgi < contactGroups.length; cgi++) {
        var groupName = clip(contactGroups[cgi].name(), 250);
        contactChoices.push({ accountId: 'contacts', folderId: String(contactGroups[cgi].id()), accountLabel: 'Contacts', label: groupName, target: contactGroups[cgi] });
        contactLabels.push(String(contactChoices.length) + '  ' + groupName);
      }
      if (operation === 'choose-contacts') {
        var contactSelected = chooseEntries(current, contactLabels, args.locale === 'zh-CN' ? '选择只读观察的联系人群组（可多选）' : 'Choose contact groups to observe read-only');
        if (typeof contactSelected === 'string') return contactSelected;
        return JSON.stringify({ ok: true, folders: contactSelected.map(function (label) { var entry = contactChoices[contactLabels.indexOf(String(label))]; return { accountId: entry.accountId, folderId: entry.folderId, accountLabel: entry.accountLabel, label: entry.label }; }) });
      }
      var contactQuery = operation === 'lookup-contacts' ? String(args.query || '').trim().toLowerCase() : '';
      if (operation === 'lookup-contacts' && (!contactQuery || contactQuery.length > 200)) throw new Error('INVALID_CONTENT');
      var contactValues = function (collection) {
        var list = [];
        try { list = collection() || []; } catch (valueError) { if (automationDenied(valueError)) throw valueError; return []; }
        var found = [];
        for (var vi = 0; vi < list.length && found.length < 12; vi++) { try { var item = clip(list[vi].value(), 320); if (item) found.push(item); } catch (valueItemError) { if (automationDenied(valueItemError)) throw valueItemError; } }
        return found;
      };
      var contactRecords = [], contactErrors = [], contactComplete = true, contactCount = 0, contactScan = 0;
      var pushPerson = function (person, scope) {
        if (++contactScan > (operation === 'lookup-contacts' ? 2000 : 400)) { contactComplete = false; return false; }
        var name = clip(person.name(), 250), organization = clip(person.organization(), 250), emails = contactValues(person.emails), phones = contactValues(person.phones), note = clip(person.note(), 8000);
        var updatedAt = isoDate(person.modificationDate()) || new Date(0).toISOString();
        var haystack = [name, organization, emails.join(' '), phones.join(' '), note].join('\n').toLowerCase();
        if (operation === 'lookup-contacts' && haystack.indexOf(contactQuery) < 0) { if (contactRecords.length >= 20) { contactComplete = false; return false; } return true; }
        if (operation === 'lookup-contacts' && contactRecords.length >= 20) { contactComplete = false; return false; }
        if (++contactCount > (operation === 'lookup-contacts' ? 20 : 400)) { contactComplete = false; return false; }
        contactRecords.push({ id: clip(person.id(), 4096), name: name || organization || '(Unnamed contact)', organization: organization, emails: emails, phones: phones, note: note, updatedAt: updatedAt, accountId: scope.accountId, folderId: scope.folderId });
        return true;
      };
      for (var csi = 0; csi < args.folders.length; csi++) {
        var contactScope = args.folders[csi], contactTarget = null;
        for (var cci = 0; cci < contactChoices.length; cci++) if (contactChoices[cci].folderId === contactScope.folderId && contactChoices[cci].accountId === contactScope.accountId) contactTarget = contactChoices[cci];
        if (!contactTarget) { contactComplete = false; contactErrors.push({ folderId: contactScope.folderId, code: 'GROUP_UNAVAILABLE' }); continue; }
        try {
          var people = contactTarget.folderId === 'all' ? contactsApp.people() : contactTarget.target.people();
          for (var cpi = 0; cpi < people.length; cpi++) if (!pushPerson(people[cpi], contactScope)) break;
        } catch (contactError) {
          if (automationDenied(contactError)) throw contactError;
          contactComplete = false; contactErrors.push({ folderId: contactScope.folderId, code: 'GROUP_UNAVAILABLE' });
        }
      }
      return JSON.stringify({ ok: true, records: contactRecords, errors: contactErrors, complete: contactComplete });
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
        if (automationDenied(error)) return JSON.stringify({ ok: false, code: 'AUTOMATION_DENIED' });
        complete = false; errors.push({ folderId: scope.folderId, code: 'FOLDER_UNAVAILABLE' });
      }
    }
    return JSON.stringify({ ok: true, records: records, errors: errors, complete: complete });
  } catch (error) {
    var code = error.errorNumber === -128 || error.number === -128 || String(error).indexOf('-128') >= 0 ? 'CANCELLED'
      : automationDenied(error) ? 'AUTOMATION_DENIED' : 'NATIVE_ACCESS_FAILED';
    return JSON.stringify({ ok: false, code: code });
  }
}
