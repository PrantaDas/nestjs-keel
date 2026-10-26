/** What a code is for. A code for one purpose never works for another. */
export type OtpPurpose = 'login' | 'verify-email' | 'reset-password' | 'change-email' | 'change-phone';

export type OtpChannel = 'sms' | 'email';

export interface OtpTarget {
  purpose: OtpPurpose;
  channel: OtpChannel;
  /** Normalised address: lower-case e-mail or E.164 phone. */
  recipient: string;
  /** Binds the code to an account (contact changes), so a code sent for one account cannot confirm another. */
  subjectId?: string;
}

/** Payload of an `otp-delivery` job. The code expires within minutes and is single-use. */
export interface OtpDeliveryJob {
  channel: OtpChannel;
  recipient: string;
  code: string;
  purpose: OtpPurpose;
  expiresInMinutes: number;
}
