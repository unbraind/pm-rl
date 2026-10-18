# Bounded recipe search approval

This example grants one two-generation search with two candidates per generation.
The outer controller reserves its declared worst-case plan once. Inner process
fits reserve and settle their measured resources under this same Decision.
Proposal calls include local model inventory and inference requests.

```json
{
  "permitted_promotions": 10,
  "resource_budget": {
    "training_steps": 10,
    "wall_ms": 300000,
    "storage_bytes": 40960,
    "compute_units": 300000,
    "tokens": 0
  },
  "meta_budget": {
    "training_samples": 2560,
    "proposal_calls": 4,
    "recipe_promotions": 2
  }
}
```
