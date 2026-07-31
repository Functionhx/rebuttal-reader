const EVERYONE = new Set(["everyone"]);

export function unwrap(value) {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "value")
  ) {
    return value.value;
  }
  return value;
}

export function isPublic(note) {
  return (note.readers ?? []).some((reader) =>
    EVERYONE.has(String(reader).toLowerCase()),
  );
}

function invitationText(note) {
  const invitations = note.invitations ?? [note.invitation].filter(Boolean);
  return invitations.join(" ");
}

function matchesAny(note, patterns) {
  const text = invitationText(note).toLowerCase();
  return patterns.some((pattern) => text.includes(pattern.toLowerCase()));
}

function contentText(note, ...fields) {
  for (const field of fields) {
    const value = unwrap(note.content?.[field]);
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

function numericScore(note) {
  const raw = contentText(
    note,
    "rating",
    "recommendation",
    "overall_score",
    "score",
  );
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function noteBody(note) {
  const preferred = [
    "review",
    "comment",
    "response",
    "author_response",
    "rebuttal",
    "response_to_reviewers",
    "summary",
    "strengths",
    "weaknesses",
    "questions",
    "metareview",
    "meta_review",
    "decision",
  ];
  const values = preferred
    .map((field) => contentText(note, field))
    .filter(Boolean);
  if (values.length) return values.join("\n\n");

  return Object.entries(note.content ?? {})
    .filter(([key]) => !["title", "rating", "confidence"].includes(key))
    .map(([, value]) => unwrap(value))
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n\n");
}

function messageTitle(note, fallback) {
  return contentText(note, "title") || fallback;
}

function noteDate(note) {
  return note.cdate ?? note.tcdate ?? note.mdate ?? 0;
}

function nearestReviewId(note, byId, reviewIds, rootId) {
  let current = note;
  const visited = new Set();
  while (current?.replyto && current.replyto !== rootId) {
    if (reviewIds.has(current.replyto)) return current.replyto;
    if (visited.has(current.replyto)) break;
    visited.add(current.replyto);
    current = byId.get(current.replyto);
  }
  return null;
}

function venueConfigFor(note, registry) {
  const venueId =
    contentText(note, "venueid") ||
    String(note.domain ?? "") ||
    invitationText(note).split("/-/")[0];
  return {
    venueId,
    config:
      registry[venueId] ??
      Object.entries(registry).find(
        ([key]) => key !== "_fallback" && venueId.startsWith(key),
      )?.[1] ??
      registry._fallback,
  };
}

export function normalizeForum(root, registry, retrievedAt = new Date().toISOString()) {
  if (!isPublic(root)) {
    throw new Error(`Forum ${root.id} is not publicly readable; skipped.`);
  }

  const { venueId, config } = venueConfigFor(root, registry);
  const replies = (root.details?.replies ?? root.replies ?? []).filter(isPublic);
  const byId = new Map(replies.map((note) => [note.id, note]));
  const reviews = replies.filter(
    (note) =>
      matchesAny(note, config.review) &&
      !matchesAny(note, config.authorResponse) &&
      !matchesAny(note, config.metaReview) &&
      !matchesAny(note, config.decision),
  );
  const reviewIds = new Set(reviews.map((note) => note.id));
  const metaReview = replies.find((note) =>
    matchesAny(note, config.metaReview),
  );
  const decisionNote = replies.find((note) =>
    matchesAny(note, config.decision),
  );

  const threads = reviews.map((review, index) => {
    const descendants = replies
      .filter(
        (note) =>
          note.id !== review.id &&
          nearestReviewId(note, byId, reviewIds, root.id) === review.id,
      )
      .sort((a, b) => noteDate(a) - noteDate(b));

    const messages = [
      {
        id: review.id,
        role: "reviewer",
        kind: "review",
        title: messageTitle(review, "Official review"),
        body: noteBody(review),
      },
      ...descendants
        .filter(
          (note) =>
            !matchesAny(note, config.metaReview) &&
            !matchesAny(note, config.decision),
        )
        .map((note) => {
          const authorSigned = (note.signatures ?? []).some((signature) =>
            /authors?/i.test(signature),
          );
          const reviewerSigned = (note.signatures ?? []).some((signature) =>
            /reviewers?|area_chairs?|editors?/i.test(signature),
          );
          const authorInvitation = matchesAny(note, config.authorResponse);
          const author =
            authorSigned || (!reviewerSigned && authorInvitation);
          return {
            id: note.id,
            role: author ? "author" : "reviewer",
            kind: author ? "author_response" : "reviewer_followup",
            title: messageTitle(
              note,
              author ? "Author response" : "Reviewer follow-up",
            ),
            body: noteBody(note),
          };
        }),
    ];

    const scoreNotes = [review, ...descendants].filter(
      (note) => numericScore(note) !== null,
    );

    return {
      id: review.id,
      label: `Reviewer ${index + 1}`,
      initialScore: numericScore(review),
      finalScore:
        scoreNotes.length > 0
          ? numericScore(scoreNotes[scoreNotes.length - 1])
          : numericScore(review),
      initialScoreLabel: contentText(review, "rating", "recommendation") || null,
      finalScoreLabel:
        scoreNotes.length > 0
          ? contentText(
              scoreNotes[scoreNotes.length - 1],
              "rating",
              "recommendation",
            ) || null
          : null,
      messages,
    };
  });

  const assignedReplyIds = new Set(
    threads.flatMap((thread) => thread.messages.map((message) => message.id)),
  );
  const generalAuthorResponses = replies
    .filter((note) => !assignedReplyIds.has(note.id))
    .filter(
      (note) =>
        !matchesAny(note, config.metaReview) &&
        !matchesAny(note, config.decision),
    )
    .filter((note) => {
      const authorSigned = (note.signatures ?? []).some((signature) =>
        /authors?/i.test(signature),
      );
      const reviewerSigned = (note.signatures ?? []).some((signature) =>
        /reviewers?|area_chairs?|editors?/i.test(signature),
      );
      return (
        authorSigned ||
        (!reviewerSigned && matchesAny(note, config.authorResponse))
      );
    })
    .sort((a, b) => noteDate(a) - noteDate(b));

  if (generalAuthorResponses.length) {
    threads.push({
      id: `${root.id}-general-response`,
      label: "全体 Reviewer",
      initialScore: null,
      finalScore: null,
      initialScoreLabel: null,
      finalScoreLabel: null,
      messages: generalAuthorResponses.map((note) => ({
        id: note.id,
        role: "author",
        kind: "author_response",
        title: messageTitle(note, "General author response"),
        body: noteBody(note),
      })),
    });
  }

  if (
    !threads.some((thread) =>
      thread.messages.some(
        (message) =>
          message.kind === "author_response" && message.body.trim(),
      ),
    )
  ) {
    throw new Error(
      `Forum ${root.id} has no public author response; skipped.`,
    );
  }

  const yearMatch = venueId.match(/(?:19|20)\d{2}/);
  const sourceTitle = contentText(root, "title");
  const title = sourceTitle || `OpenReview paper ${root.id}`;
  const authors = unwrap(root.content?.authors);
  const keywords = unwrap(root.content?.keywords);
  const decision =
    contentText(decisionNote ?? {}, "decision", "recommendation") ||
    contentText(root, "venue") ||
    "Decision not recorded";

  return {
    id: root.id,
    title,
    titleKind: sourceTitle ? "paper_title" : "identifier",
    authors: Array.isArray(authors) ? authors.map(String) : [],
    venue:
      config.label ||
      contentText(root, "venue") ||
      venueId ||
      "OpenReview",
    year: yearMatch ? Number(yearMatch[0]) : new Date().getFullYear(),
    materialType: /TMLR/i.test(venueId)
      ? "response_to_reviewers"
      : "conference_rebuttal",
    decision,
    accepted: /accept|poster|spotlight|oral/i.test(decision),
    abstract: contentText(root, "abstract"),
    topics: Array.from(
      new Set([
        ...(Array.isArray(keywords) ? keywords.map(String) : []),
        contentText(root, "primary_area"),
      ].filter(Boolean)),
    ).slice(0, 6),
    scoreBefore: threads
      .map((thread) => thread.initialScore)
      .filter((score) => score !== null),
    scoreAfter: threads
      .map((thread) => thread.finalScore)
      .filter((score) => score !== null),
    metaReview: metaReview ? noteBody(metaReview) : null,
    threads,
    source: {
      type: "openreview_api",
      label: "OpenReview API",
      url: `https://api2.openreview.net/notes?id=${encodeURIComponent(root.id)}`,
      originalUrl: `https://openreview.net/forum?id=${encodeURIComponent(root.id)}`,
      license: String(root.license ?? "Per-note license"),
      retrievedAt,
    },
  };
}
