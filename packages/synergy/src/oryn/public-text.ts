export namespace OrynPublicText {
  const patterns: Array<[RegExp, string]> = [
    [/ghp_[A-Za-z0-9]{10,}/, "a GitHub token"],
    [/github_pat_[A-Za-z0-9_]{10,}/, "a fine-grained GitHub token"],
    [/sk-[A-Za-z0-9-]{10,}/, "an API key"],
    [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/, "a private key"],
    [/\bses_[a-zA-Z0-9]{8,}\b/, "an internal session id"],
    [/\borc_[a-zA-Z0-9]{8,}\b/, "an internal case id"],
    [/(\/Users\/|\/home\/)[A-Za-z0-9._-]+/, "an absolute home path"],
    [/(?:file:\/\/|\/private\/var\/|\/tmp\/|[A-Z]:\\Users\\)/i, "a local runtime path"],
    [/https?:\/\/(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i, "a private endpoint"],
  ]

  export function violations(value: string): string[] {
    return patterns.filter(([pattern]) => pattern.test(value)).map(([, label]) => label)
  }
}
