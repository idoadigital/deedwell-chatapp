export { emailConfig, type EmailConfig } from "./config.js";
export { renderEmail, escapeHtml, BRAND, type EmailDoc, type Block } from "./layout.js";
export { createResendSender, ResendError, type ResendSender, type OutboundEmail } from "./resend.js";
export { renderTemplate, linksFor, EMAIL_CATEGORY, EMAIL_KINDS, type EmailKind, type EmailPayloads, type EmailCategory } from "./templates.js";
export { enqueueEmail, sweepEmailOutbox, type EnqueueEmailInput, type SweepOptions, type SweepResult, type Queryable } from "./outbox.js";
export { orgRecipients, userRecipient, orgNameOf, emailOrgAdmins, emailUser, emailOps, type Recipient } from "./recipients.js";
export { unsubscribeToken, verifyUnsubscribeToken, unsubscribeUrl } from "./unsubscribe.js";
export { SAMPLES as EMAIL_SAMPLES } from "./samples.js";
