# Certified identical: PR 91 evidence

The six frames in this directory are the captures taken on PR 91 head `d7066b12e0f42607292d17c44ca09881fbfd29e8` (published under `pr-91/d7066b12e/`), republished unchanged for head `f6b605530096f9c666d0caaee80afad0d5a748ec`.

`git diff d7066b12e0f42607292d17c44ca09881fbfd29e8 f6b605530096f9c666d0caaee80afad0d5a748ec -- apps packages` is empty: every code path the frames exercise (DeliveryTransport, the J5 composer policy module, ChatComposer, ComposerPrimaryActions) is byte-identical between the two heads. The rebase changed only FORK.md (the J5 case is appended as 24 after main's last case) and dropped the Director-owned friction-list hunk.

SHA-256 of each PNG matches `pr-91/d7066b12e/SHA256SUMS`.
