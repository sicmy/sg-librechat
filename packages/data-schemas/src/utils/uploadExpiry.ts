export const SG_UPLOAD_TTL_GRACE_MS: number = 60 * 60 * 1000;

export function isSGFileExpired(
  file: { expiredAt?: Date | null; sgUploadExpiresAt?: Date },
  now: Date,
): boolean {
  return (
    (file.expiredAt instanceof Date && file.expiredAt.getTime() <= now.getTime()) ||
    (file.sgUploadExpiresAt instanceof Date &&
      file.sgUploadExpiresAt.getTime() + SG_UPLOAD_TTL_GRACE_MS <= now.getTime())
  );
}
