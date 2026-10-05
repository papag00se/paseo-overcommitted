// An intentional wait for observed activity or an explicit safety policy is not
// a Git/inspection failure. Unexpected failures must remain visible as errors.
export class ActivityBlocked extends Error {}
