# The relay / cache tier

**Status: blocked, deliberately, on two preconditions written into the source.** Not "not started".

```
lib/mesh/capabilities.js   'redistributes-content' … phase5: true — REFUSED by validation
                           "This is the one that inverts I2's direction, so it gets its own
                            security review."
lib/mesh/pairing.js        maxDepth 2 — "Raise MESH_MAX_DEPTH only once a two-tier mesh has
                            been proven on real hardware."
```

Neither is met. This document exists so the review those notes ask for has something to review.

## Why it cannot simply be built now

**There is no topology for it to serve.** A relay "caches and serves media to its subtree", and at
`MESH_MAX_DEPTH = 2` there is no subtree: a hub has children and the children have nothing below
them. Every child already pulls directly from the hub it enrolled with. Building the relay before
raising the cap produces code that cannot be exercised — and the cap is itself gated on proving the
two-tier mesh on real hardware first, which has not happened.

That ordering is not bureaucracy. The content transfer that shipped this week has never run over a
real WAN link between two real sites; its resume path was inert for its first hour of existence and
looked fine, because the file arrived anyway. Stacking an untested tier on an unproven one means the
first failure is ambiguous between them.

## What it actually inverts

Every other mesh capability moves data **upward** or lets a parent **ask**. I5 is explicit that a
relayed envelope is *relayed, not interpreted, not stored*. A cache stores. That single word is the
whole security review:

- **A relay holds bytes belonging to a customer who never agreed to that node holding them.** Today
  a customer grants a specific hub a storage allowance on their own disk. In a three-tier mesh, the
  hub pushes through a regional node — which now stores that customer's media, on hardware the
  customer has no relationship with. Nobody in the current consent model is asked.
- **A relay serves content it did not originate.** The pull ticket is minted by the node that owns
  the file and is checked against a live read of *its* edge. A relay serving a cached copy must
  either mint its own tickets (making it an authority for content it does not own) or proxy the
  originator's (making every transfer depend on a node that may be offline — which is precisely what
  the cache was for).
- **Revocation stops meaning what it means.** A customer revoking write access today stops future
  writes and can then delete what was pushed. With a cache in between, their content persists on a
  third node with its own retention, and the revoke reaches nothing.

## The questions that need a decision, not an implementation

1. **Does a relay cache a customer's content at all, or only content the relay's own operator owns?**
   The second is far weaker and far safer, and may be enough: an MSP pushing *their* campaign to
   forty sites is the actual bandwidth case, and that content belongs to the MSP.
2. **If it does cache customer content — who consents?** The child whose bytes they are has no edge
   to the relay and no page on which to be asked. A consent model where the party giving something
   up cannot see the request is the failure this whole design was built against (see I10).
3. **Whose storage allowance pays for a cached copy?** It is not the child's disk and not the
   originating hub's. A third accounting axis, or the cache is unbounded.
4. **Does a relay verify before serving?** It must — digest-check on ingest and on serve. A relay
   serving one wrong file puts that file on every screen beneath it, which is a larger blast radius
   than any single node has today.
5. **What happens when the originator revokes or deletes?** Either the cache honours a purge it can
   be told about (a new downward verb, with all that implies) or cached content outlives the
   relationship that created it.

## Decision taken: both modes, and the flag is not where the authority lives

Question 1 is answered — **both**. An MSP pushing their own campaign to forty sites and a customer
distributing their own media between their own sites are both real, and one build should serve both.

⚠️ **But "configurable" cannot mean one flag.** Whoever sets a flag on the relay is the relay's
operator — the party that BENEFITS from caching — while the party giving something up is the
customer whose bytes land on a node they have no relationship with. A single setting hands the
decision to the wrong side of the transaction, which is exactly the defect the write grant already
had once: the parent authored the grant the child enforced, and it took an amendment to I2 to fix.

So it is two settings, held by two parties, and both are required before a byte is cached:

| Setting | Held by | Answers | Nature |
|---|---|---|---|
| `redistributes-content` capability | the relay's operator | "am I willing to spend my disk and bandwidth being a cache?" | a RESOURCE decision |
| a cache consent on the write grant | the content's owner | "may my media be held on intermediate servers to reach my other sites?" | an AUTHORITY decision |

The first is a capability declaration, like every other one on an edge — it says what a node *can*
do, never what it *may*. The second is a new consent on the existing grant surface: the same page,
the same wording discipline, the same partial revocation. Absent means no, as it does everywhere
else in this design, so every existing relationship stays uncached until somebody says otherwise.

**The conservative mode falls out for free rather than being a separate build.** Content the relay's
own operator owns needs no cache consent from anyone, because the relay operator IS the owner — the
consent check simply passes trivially. So "MSP caches their own campaign" works with nothing ticked,
and "customer's media crosses a third node" requires the customer to have said so. One mechanism,
two behaviours, and the difference is whose content it is rather than whose flag is set.

### What the consent must say

The sentence has to name the thing a customer cannot infer: that a copy of their media will sit on
a server belonging to somebody they have no contract with, for as long as that server keeps it.
Anything vaguer and the screen overstates what it grants — the failure this design keeps returning
to. It should also say what revocation does and does not reach, because the honest answer is that a
cached copy outlives the relationship unless the purge verb below exists.

### What it still forces us to build

- **A downward purge verb.** With cache consent revocable, revoking has to reach the cached copies,
  or revocation means less than it says. That is a new downward message and needs the same allowlist
  treatment as every other one (I2).
- **Digest verification on ingest AND on serve.** A relay serving one wrong file puts it on every
  screen beneath it — a larger blast radius than any single node has today. The child still verifies
  independently, so a compromised relay cannot substitute a file, but it must not be the only check.
- **A third accounting axis.** A cached copy is on neither the child's disk nor the originating
  hub's. Unbounded otherwise.

## Preconditions to lift before writing any of it

1. A two-tier mesh running on real hardware across a real WAN link, with the content transfer
   exercised on a link that genuinely drops. Not a lab.
2. ~~An answer to question 1~~ — answered: both, via two settings held by two parties (above).
   What remains is question 2's mechanics: the exact consent wording, and the purge verb that makes
   revoking a cache consent mean something.
3. `MESH_MAX_DEPTH` raised only after 1, and only for topologies that have been drawn out. A depth
   of 3 with N regional nodes is a different failure surface from a chain of 3.
