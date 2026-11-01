# Sequential sweep equivalence

The sweep discovers every before/after SDK edge on a prepared real tracker. It
keeps every peer-affected mutable observation, missing birth, history enumeration of a mutable
item, write, candidate-discovery edge, and first/last edge of each observation
kind. Independent peer transitions run two at a time on separate private roots.
Each case branches one prepared native fixture, retaining independent SDK/cache
identity and its own append-only audit until disposal. Production writes remain
forward-only.

Only observations outside the selected peer transition's native write set commute:
project id-prefix reads; reads/history of unaffected native items; and
version-one reads of items already present
in the prepared SDK inventory. A missing record is never an immutable birth.
The write sets are explicit in `peerAffects`: SDK rejection changes the candidate;
package rejection may also create policy cards; sealing creates the plan; look
transitions create checkpoints; budget changes the approval. Every executed peer
transition hashes settings, schema and every native item/history outside its
write set, plus every prepared creation record, before and after the real SDK
action. A changed write set fails the proof assertion. No birth that was absent
from the prepared inventory is considered immutable. Every sampled commuting
observation is also executed through the unwrapped native peer SDK before and
after the peer action; its projected item, history entries or setting must be
deep-equal, including typed absence. Each replay also classifies the actual
pre-injection observations: a reordered parallel completion cannot turn a
sampled slot into a mutable read or write without failing the sweep.

Inside a region with unchanged native file and held-lease generations, these
observations return the same projected values whether the peer runs before or
after them. Their pure validation and local observer updates therefore commute
with that peer transition. Moving the peer across the region preserves its
native outcome, the primary verdict and the resulting state. A peer-affected mutable SDK edge
or any native/lease-generation change ends the region. Seed `0x1071647` selects a
reproducible native witness per region; logs record discovered and exercised
counts. Directory touch times and derived query telemetry are not decision state.

Snapshot-corruption checks use no sampling: every input and every pair still runs
against native SDK history. Each pair forks one prepared final tracker, keeping
its corruption event while preventing prior cases from growing later histories.
