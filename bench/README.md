# Benchmark tokens glab vs glab-axi

`bench/run.ts` mesure, pour chaque commande de lecture portée par `glab-axi`, le nombre de
tokens (encodage `o200k_base`, via `gpt-tokenizer/model/gpt-4o`) de la sortie brute de `glab`
comparée à celle de `glab-axi`, sur un projet GitLab réel en lecture seule.

## Relancer

```sh
pnpm build
pnpm exec tsx bench/run.ts
```

Prérequis : `glab` installé et authentifié (`glab auth status`) sur `git.geofoncier.fr`, accès
en lecture au projet `geofoncier/geofoncier-back`.

Le script résout `glab` par chemin absolu (`which glab` capturé une fois, puis appelé via
`execFile` — jamais via un shell) pour éviter tout hook shell qui filtrerait ou résumerait
la sortie (ex. rtk sur les machines qui l'utilisent). `glab-axi` est invoqué depuis
`dist/bin/glab-axi.js`, `GITLAB_HOST=git.geofoncier.fr` pour cibler l'instance self-managed.

## Séquences choisies par commande

La plupart des commandes ont un équivalent `glab` direct. Trois n'en ont pas :

- **`ci view`** — `glab ci view` est un TUI interactif, inutilisable pour une capture
  scriptée. Séquence retenue : `glab api projects/:id/pipelines/:pipeline_id` +
  `glab api projects/:id/pipelines/:pipeline_id/jobs` (deux appels API concaténés), la
  manière dont un agent reconstituerait la même information sans TUI.
- **`snippet list`** — `glab snippet` n'expose ni `list` ni `view` (seulement `create`).
  Séquence retenue : `glab api projects/:id/snippets`.
- **`home`** (dashboard global, non scopé à un projet) — pas de commande `glab` équivalente.
  Séquence retenue : `glab api user` + `glab api "merge_requests?scope=assigned_to_me&state=opened&per_page=3"`
  - `glab api "issues?scope=assigned_to_me&state=opened&per_page=3"` + `glab api "todos?per_page=3"`,
    les quatre appels que `src/commands/home.ts` fait lui-même côté `glab-axi`.

Les identifiants variables (iid de MR ouverte, iid d'issue ouverte, id de pipeline) sont résolus
dynamiquement en tête de script via `glab api`, pour que le benchmark reste rejouable sans
édition manuelle au fil du temps.

## Anomalies connues

- **`snippet list`** : le projet cible n'a aucun snippet (vérifié aussi sur `api-dossiers` et
  `api-auth`) — la paire glab/glab-axi est mesurée sur une liste vide des deux côtés. Le delta
  (+4600 %) vient du seul texte fixe de `glab-axi` (`count: 0` + suggestion) contre la sortie
  vide de l'API brute (`[]`) ; mesure valide mais faible, à ne pas généraliser.
- **`variable list`** : `glab` n'affiche jamais les valeurs des variables dans son tableau
  (`KEY/PROTECTED/MASKED/...`, pas de colonne valeur), alors que `glab-axi variable list`
  affiche les valeurs en clair (comportement documenté dans `AGENTS.md` : les variables ne sont
  pas traitées comme des secrets). C'est ce qui explique le delta très positif — comparaison
  volontairement asymétrique en fonctionnalité, pas un artefact de mesure à corriger.
