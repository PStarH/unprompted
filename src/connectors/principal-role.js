// Recipient metadata establishes participation, not permission to act.
// Structured provider assignment, mention, or group membership can name a role.
// Message text never does.
export function structuredPrincipalRole({ account, to = [], cc = [], assignedAccount = null, mentionedAccounts = null, groupMemberIds = null } = {}) {
  const identity = typeof account === 'string' ? account.trim().toLowerCase() : '';
  const same = value => typeof value === 'string' && value.trim().toLowerCase() === identity;
  if (identity && same(assignedAccount)) return { principalRole: 'DIRECT_ACTOR', roleEvidence: { basis: 'provider_assignment' } };
  if (identity && Array.isArray(mentionedAccounts) && mentionedAccounts.some(same)) return { principalRole: 'DIRECT_ACTOR', roleEvidence: { basis: 'provider_mention' } };
  const email = emailPrincipalRole(account, to, cc);
  if (identity && Array.isArray(groupMemberIds) && groupMemberIds.some(same) && email.principalRole !== 'DIRECT_ACTOR') return { principalRole: 'SHARED_GROUP', roleEvidence: { basis: 'shared_group_membership' } };
  return email;
}

export function emailPrincipalRole(account, to, cc) {
  const address = value => typeof value === 'string' && /^[^\s@,<>]+@[^\s@,<>]+$/.test(value.trim()) ? value.trim().toLowerCase() : null;
  const identity = address(account);
  if (!identity || !Array.isArray(to) || !Array.isArray(cc)) return { principalRole: 'UNKNOWN', roleEvidence: { basis: 'recipient_metadata_incomplete' } };
  const recipients = to.map(address), copies = cc.map(address);
  if (recipients.includes(null) || copies.includes(null)) return { principalRole: 'UNKNOWN', roleEvidence: { basis: 'recipient_metadata_incomplete' } };
  if (recipients.includes(identity)) return { principalRole: recipients.length === 1 ? 'DIRECT_ACTOR' : 'SHARED_GROUP', roleEvidence: { basis: recipients.length === 1 ? 'sole_to_recipient' : 'multiple_to_recipients' } };
  if (copies.includes(identity)) return { principalRole: 'PASSIVE_OBSERVER', roleEvidence: { basis: 'cc_recipient' } };
  return { principalRole: 'UNKNOWN', roleEvidence: { basis: 'account_not_in_recipients' } };
}

// A partial parse must not turn a group message into a direct assignment.
export function simpleMailboxList(header) {
  if (header == null || header === '') return [];
  if (typeof header !== 'string' || /[;:\r\n]/.test(header)) return null;
  return header.split(',').map(part => {
    const match = part.trim().match(/^(?:[^<>" ,]+(?:\s+[^<>" ,]+)*\s*<([^<>\s]+)>|([^<>\s]+))$/);
    return match ? match[1] || match[2] : null;
  });
}
