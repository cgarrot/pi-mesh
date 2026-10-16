# OPencode-PLAN — faire de pi-mesh utilisable sous OpenCode

* Analyse de l'existant (`review`) + plan d'intégration OpenCode.
* **Objectif (confirmé par l'utilisateur) :** le scénario principal est que
  l'agent OpenCode communique avec les sessions Pi (et réciproquement) via
  le même broker — OpenCode et Pi étant tous deux de simples clients du
  broker, cette communication fonctionne déjà par conception (multi-hôte).
* **Exigence de modularité :** l'intégration OpenCode doit être au même
  niveau que l'intégration Pi — un second adaptateur symétrique qui réutilise
  (jamais duplique) la logique partagée. Aucun fichier de `src/extension/`
  ne doit être modifié.
* Statut: proposition. Aucun fichier existant n'a été modifié (y compris le
  brouillon local v0.7.3 sur le lock du broker).

---

## Sommaire

1. [Review de pi-mesh](#review-de-pimi-mesh)
   - [1.1 Architecture et couches](#11-architecture-et-couches)
   - [1.2 Le cœur est host‑agnostique](#12-le-cœur-est-hostagnostique)
   - [1.3 La couche Pi — la seule vraie spécificité](#13-la-couche-pi--la-seule-vraie-spécificité)
   - [1.4 Mode d'usage : Pi (extension) vs CLI (`pimesh`)](#14-mode-dusage--pi-extension-vs-cli)
   - [1.5 État local du dépôt (WIP à ne pas toucher)](#15-état-local-du-dépôt-wip-à-ne-pas-toucher)
2. [Plan d'intégration OpenCode](#plan-dintégration-opencode)
   - [2.1 Pourquoi c'est faisable, et ce qui doit être réécrit](#21-pourquoi-cest-faisable-et-ce-qui-doit-être-réécrit)
   - [2.2 Mapping Pi → OpenCode](#22-mapping-pi--opencode)
   - [2.3 Design proposé](#23-design-proposé)
     - [2.3.1 Structure du nouveau dossier d'adaptateur](#233-structure-du-nouveau-dossier-dadaptateur)
     - [2.3.2 Cycle de vie d'une session (identité, alias, reconnect)](#233-cycle-de-vie-dune-session-identité-alias-reconnect)
     - [2.3.3 Injection des messages entrants](#233-injection-des-messages-entrant)
     - [2.3.4 Interrupt / unblocking (force + interrupt)](#233-interrupt--unblocking-force--interrupt)
     - [2.3.5 Permissions et réservations de fichiers](#233-permissions-et-réservations-de-fichiers)
     - [2.3.6 Activité, statut et accusés de lecture (read receipts)](#233-activité-statut-et-accusés-de-lecture-read-receipts)
     - [2.3.7 Skills et documentation agent-facing](#237-skills-et-documentation-agent-facing)
     - [2.3.8 Différences d'UI : renderer, HUD, couleurs](#238-différences-dui--renderer-hud-couleurs)
   - [2.4 Intégration utilisateur et packaging](#24-intégration-utilisateur-et-packaging)
   - [2.5 Plan d'implémentation en phases](#25-plan-dimplémentation-en-phases)
   - [2.6 Tests](#26-tests)
   - [2.7 Points de décision à valider](#27-points-de-décision-à-valider)

---

# Review de pi-mesh

## 1.1 Architecture et couches

`pi-mesh` (v0.7.3, package `pi-mesh-extension`, Node ≥ 20, **zéro dépendance
runtime**) est un système de communication **agent‑à‑agent en temps réel**,
organisé en couches très classiques :

```
src/
├── protocol/    mesh.v1 — le squelette du wire (frames NDJSON, validation,
│                hash des bodies, msgIds). 100 % générique.
├── shared/      — config (bornes nommées), résolution des répertoires
│                d'état/runtime, persistance de l'identité, réservations.
│                Aucune import de Pi.
├── broker/      — serveur: unix socket / tcp+tls, dispatch des frames,
│                rooms, mailbox hors-ligne, rate limits, politique,
│                présence, purge. Générique (node:net / node:tls).
├── client/      — MeshClient: hello/acks/status, missions `awaitReply`,
│                reconnect, outbox. Émet des frames ; consomme par l'adaptateur.
│                Aucune import de Pi.
├── extension/   — L'ADAPTATEUR Pi UNIQUEMENT :
│                tools Pi (mesh_send …), commande `/mesh …`, injection dans
│                la session Pi, renderers TUI, HUD, watchdog, accusés de
│                lecture, détection d'erreurs fournisseur.
└── cli/         — `pimesh`, le peer/CLI autonome : `attach` (REPL ou pipe
                 NDJSON), send/reply/ping/wait, doctor, watch… Aucune import
                 de Pi.
```

Les quatre premières couches n'importent **aucun module Pi** : tout leur
comportement est piloté par la même `MeshConfig` (config.json + env
`MESH_*`) que le CLI utilise. La couche `extension/` est, elle, un *adaptateur*
au sens strict — son entrée (`index.ts`) reçoit l'API de l'hôte et traduit les
événements du broker en actions de l'hôte (injecter un message dans la
session, afficher un widget, …). Ce n'est que ~15 fichiers sur ~40, et ils
dépendent du moins de la surface `ExtensionAPI` de Pi — que pi-mesh reproduit
en local dans `src/extension/pi-types.ts` (interfaces minimales, **sans
import** du paquet `@mariozechner/pi-tui`).

## 1.2 Le cœur est host‑agnostique

C'est le point central de cette analyse. Si demain OpenCode venait à disparaître
ou de changer radicalement d'API, **seul le dossier `extension/` serait à
réécrire** ; le broker, les clients, le protocole, la persistance et la CLI
continueraient de fonctionner, et même `pimesh attach` (peer autonome) serait
immédiatement utilisable avec un hôte quelconque.

Preuves concrètes dans le code :

- `src/protocol/` (`envelope.ts`, `frames.ts`) — types du wire, validation
  commune des deux côtés. Aucun import de Pi.
- `src/shared/` — `config.ts` (bornes + precedence), `paths.ts`
  (`MESH_STATE_DIR` / `MESH_RUNTIME_DIR`), `identity-store.ts`
  (identité persistée **par session id**), `reservations.ts`.
- `src/broker/` — `broker.ts` (serveur unix + tcp/tls, lock, silence sweep),
  `mailbox.ts`, `rooms.ts` (présence), `ratelimit.ts`, `policy.ts`,
  `state.ts`.
- `src/client/` — `client.ts` (MeshClient, reconnect auto-spawn du broker),
  `pending.ts` (missions `awaitReply`), `reconnect.ts` (ensureBroker).
- `src/cli/` — `mesh.ts` + `cmd/` : tout parle au broker via `MeshClient`,
  jamais à Pi.

L'adaptateur Pi (`src/extension/`) n'est qu'un *client* supplémentaire du
même broker : il utilise exactement les mêmes fonctions `MeshClient` que la CLI.
La séparation est donc déjà bien pensée ; elle justifie sans ambiguïté la
futur portage.

## 1.3 La couche Pi — la seule vraie spécificité

Sous `src/extension/`, chaque fichier est lié à l'API de Pi :

| Fichier | Rôle | Spécifique à Pi ? |
|---|---|---|
| `pi-types.ts` | miroir local des interfaces `ExtensionAPI` (registerTool, registerCommand, sendMessage, renderers, thèmes). Le fichier documente « ZERO imports from Pi packages ». | oui — définit le contrat d'entrée de Pi |
| `index.ts` | câblage des événements Pi → runtime (session_start, tool_call, turn_end, agent_settled…), HUD, watchdog, garde des réservations. | oui |
| `tools.ts` | enregistre les 8 outils (`mesh_send`, `mesh_reply`, …) avec descriptions/schémas JSON. | oui |
| `commands.ts` | la commande slash `/mesh …` (status, join, alias, new, reset, …). | oui |
| `inbound.ts` | traduit les frames entrantes en *messages* injectés dans la session Pi (`followUp` / `steer` / `force`), batching, accusés de lecture. | oui |
| `attach.ts` | listeners du client, alias adoption, comptage des lectures (`read` receipts, TTY). | oui |
| `renderer.ts` (+`colors.ts`) | rendu des messages custom du TUI Pi (largeur ANSI, couleurs par alias). | oui — importe `@mariozechner/pi-tui` |
| `hud.ts` | widget footer au-dessus de l'éditeur. | oui |
| `watchdog.ts`, `provider-errors.ts` | détection de tours dégénères / erreurs fournisseur, annoncées via l'UI. | oui |
| `guards.ts`, `batcher.ts`, `deferred-inbox.ts` | logique pure (anti-boucles, batching) — **hors spécificité**, réutilisable tel quel. | non |
| `ledger.ts`, `transcript.ts` | persistance hachée / transcript — réutilisable tel quel. | non |

Trois conséquences directes pour un portage :

1. **`pi-types.ts` est le seul vrai blocage de type.** Le reste du code
   (`guards`, `batcher`, `ledger`, `inbound`…) est écrit contre cette
   interface et n'a aucune connaissance de Pi au-delà de ce type. Si ce type
   était déplacé dans un paquet « host‑agnostic », l'adaptateur pourrait
   s'appuyer sur les types réels de l'hôte sans toucher au reste.
2. **Le rendu TUI et le HUD n'ont aucun équivalent OpenCode plugin V2.**
   OpenCode expose des hooks pour le *contenu* des messages (transform),
   mais pas de registre de « custom message renderer » comme Pi. Le portage
   devra accepter l'injection « en tant que message utilisateur normal » et
   perdre les rendus colorés (détail §2.8).
3. **L'identité de session repose sur `sessionManager.getSessionId()`** de Pi
   (`session_start` réutilise la session id stable à travers `/reload`). Or,
   OpenCode a aussi des identifiants de session (`sessionID`) exposés par son
   SDK — le même mécanisme de persistance
   (`identity-<sessionId>.json` dans `<stateDir>/`) peut être réutilisé sans
   changement.

## 1.4 Mode d'usage : Pi (extension) vs CLI (`pimesh`)

Le système est utilisé de deux manières complémentaires, toutes deux connectées
au **même broker** (démarré automatiquement au premier client) :

**Mode A — dans Pi (l'extension).**
- `pi install npm:pi-mesh-extension` : le paquet s'enregistre comme *pi package* ;
  son extension (`index.ts`) se charge automatiquement à chaque session Pi.
- Chaque session Pi reçoit **son alias mesh** au démarrage et reçoit en
  inbox les messages qui lui sont destinés (`[mesh] @from …` est injecté comme
  un *followUp* : le tour du modèle reprend automatiquement).
- Les outils `mesh_*` sont des outils du modèle : l'agent les appelle comme
  n'importe quel outil (`mesh_send`, `mesh_reply`, `mesh_status`,
  `mesh_wait_all`, `mesh_ledger`, `mesh_reserve`, `mesh_release`,
  `mesh_history`).
- La commande `/mesh` gère l'administratif (join/leave, alias, new/reset,
  ping, broker, inbox…).
- Les capacités avancées sont purement *outils* : aucune action humaine n'est
  requise pour les deux sessions connectées.

**Mode B — via la CLI (`pimesh`).**
- `pimesh attach [alias]` : démarre un **peer mesh autonome** — ni Pi, ni
  serveur d'agent. C'est une REPL interactive ou un pipe NDJSON scriptable
  (`--json`) ; le peer reçoit les messages **avec corps** et peut répondre.
- `pimesh send / reply / ping / wait / ledger / tail / status / …` : client
  *one-shot* pour scripts et débogage ; jamais en arrière-plan.
- La même instance peut coexister avec des sessions Pi : c'est exactement
  comme dans le multi-machine (VPS + poste local) — le broker est l'unique
  point de rendez-vous.

**En résumé pour l'utilisateur** : Pi = « les agents sont les acteurs » (outils
dans leur tour, inbox vivante) ; CLI = « les scripts/terminaux sont des
acteurs » (attach REPL ou pipe). Le broker est explicitement multi-hôte (déjà
documenté « Multi-machine ») : toute extension d'hôte est un client additionnel.
C'est précisément ce qui rend possible le scénario principal du portage
OpenCode — voir §2 — : un agent OpenCode dialogue avec les sessions Pi
(et réciproquement) sur le même broker. La CLI existante (Mode B) reste
inchangée, et OpenCode rejoint le Mode A sans la modifier.

## 1.5 État local du dépôt (WIP à ne pas toucher)

Le dépôt contient des modifications **non commitées** (`git status` montre
`M` sur `package.json`, `src/broker/broker.ts`, `src/client/reconnect.ts`,
`src/shared/config.ts`, `src/shared/version.ts`, + 2 fichiers non suivés :
`scripts/broker-watchdog.mjs`, `test/lock-takeover.test.ts`).

Il s'agit d'une évolution en cours : la reprise de lock quand le pid du lock
est recyclé (prise de lock avec vérification que le socket répond —
`LOCK_VERIFY_WAIT_MS`, `socketServes`, unlink du lock orphelin côté
reconnect). C'est la v0.7.3 en cours de préparation.

*J'ai volontairement **non modifié** ces fichiers* : la présente analyse et
plan ne dépend pas de ce diff, et il faut pas l'entrer en conflit. À noter
aussi : `package.json`/`version.ts` indiquent déjà `0.7.3` alors que le
dernier commit marqué `0.7.2` — le brouillon semble prêt pour la sortie.

---

# Plan d'intégration OpenCode

## 2.1 Pourquoi c'est faisable — et le scénario principal

Verdict global : **oui, faisable, avec un effort concentré sur un seul dossier.**
Le cœur (`protocol`, `broker`, `client`, `shared`, `cli`) est multi-hôte *par
conception* : tout y est un simple client du broker. Seul `src/extension/`
est spécifique à Pi, et même lui est bien découpé en deux parties :

- **réutilisable tel quel** (aucune modification requise) :
  `shared/` (config, identité, réservations), `protocol/`, `broker/`,
  `client/` (MeshClient, pending, reconnect), `cli/` ;
  plus la logique pure de `extension/` qui n'importe pas Pi :
  `guards.ts`, `batcher.ts`, `deferred-inbox.ts`, `ledger.ts`,
  `transcript.ts`, `inbound.ts` (hors injection), `provider-errors.ts`.
- **à réécrire pour OpenCode** (les ~10 fichiers de `extension/`) :
  `pi-types.ts` (contrat hôte), `index.ts` (câblage), `tools.ts`
  (enregistrement d'outils), `commands.ts` (commandes), `inbound.ts`
  (injection — réécrite contre l'API session d'OpenCode), `attach.ts`
  (listeners — perte partielle), `renderer.ts` / `colors.ts` /
  `hud.ts` (perte totale).

Le scénario principal pour ce portage est précisément ce que cette analyse
rend possible **sans aucun changement du cœur** : un agent OpenCode dialogue
avec les sessions Pi (et réciproquement) via le même broker — OpenCode et Pi
étant tous deux de simples clients, la communication fonctionne déjà par
conception (c'est la ligne « multi-machine » du README). C'est ce scénario
qui motive le portage, et c'est lui qui justifie de ne pas sacrifier la
couche commune.

Le portage se fait donc **en ajoutant un dossier** ; aucun fichier existant
n'a à changer, ce qui est un critère de risque faible.

## 2.2 Mapping Pi → OpenCode

L'API plugin V2 d'OpenCode (documentée sur <https://opencode.ai/v2/docs/build/plugins>,
source de vérité ; le plugin local installé chez vous est en version 1.x et expose
aussi l'ancien hook `chat.message` — voir §2.4) offre des équivalents directs
pour presque toutes les capacités de pi-mesh :

Concrètement, et comme rappelé en §2.1, le scénario principal est **OpenCode ↔ Pi**
via le broker partagé — l'outil dont on a ici besoin avant tout est celui qui
permet à une session OpenCode de rejoindre le même mesh que les sessions Pi.

| Capacité pi-mesh (Pi) | Équivalent OpenCode V2 | Remarques |
|---|---|---|
| Enregistrer des outils (`mesh_send`, …) | `ctx.tool.transform` — `editor.add({…})` | mêmes descriptions / schémas JSON ; nommage non namespacé recommandé pour garder les mêmes noms que sous Pi |
| Intercepter un appel d'outil (réservations) | `ctx.tool.hook("execute.before")` + `ctx.permission.hook("evaluate")` | l'évaluation peut *deny* (`event.effect = "deny"`) — c'est le levier de blocage ; `execute.before` permet d'inspecter les args |
| Commande slash `/mesh …` | `ctx.command.transform` — `editor.add({execute})` | la commande est enregistrée comme commande d'OpenCode, pas comme slash du TUI pi |
| Injecter un message entrant dans la session (followUp/steer) | `ctx.session.prompt({sessionID, text, delivery})` — `delivery: "steer" \| "queue"` | `prompt` = message utilisateur ; `synthetic` = message transitoire |
| Interrompre le tour en cours (ESC / force+interrupt) | `ctx.session.interrupt({sessionID, continue})` | correspondance quasi parfaite à `ctx.abort()` de Pi |
| Attendre la fin d'une session (orchestration `wait_all`) | `ctx.session.wait({sessionID})` | un tool peut suspendre son tour ; à combiner avec la mission registry |
| Présence / statut broker | `ctx.event.subscribe` + polling des `status_req` côté MeshClient | le MeshClient expose déjà `status()` ; l'annonce d'activité dépend des hooks V2 (voir §2.6) |
| Alias / identité par session | identifiant de session OpenCode, même fichier `identity-<sessionId>.json` | réutilisable tel quel |
| Rendu des entrants (couleurs par alias) | **absent** | limitation acceptée (§2.8) |
| Widget HUD / notifications UI | **absent** | limitation acceptée (§2.8) |
| Skills (`mesh-coordination`) | `ctx.skill` / configuration `skills` | réutilisable (§2.7) |

Les deux seuls points sans équivalent direct sont purement **UI**
(renderers, HUD) : OpenCode n'expose pas de registre de custom message
renderers pour les plugins V2 (seul un transform de contenu est exposé). Tout
le reste — y compris l'interruption — est couvert.

## 2.3 Design proposé

### 2.3.1 Structure du nouveau dossier d'adaptateur

Ajout d'un dossier `src/extension-opencode/` (nommage aligné sur
`extension/`), compilé dans le même `dist` :

```
src/extension-opencode/
├── index.ts          — entrypoint plugin (default export). Câble tout.
├── client-runtime.ts — cycle de vie d'un MeshClient par session OpenCode :
│                      alias, identité, reconnect, listeners, détection
│                      d'activité.
├── register-tools.ts — ctx.tool.transform : les 8 outils mesh_* (mêmes
│                      descriptions/promptGuidelines que sous Pi).
├── register-commands.ts — ctx.command.transform : la commande `/mesh …`.
├── inbound.ts        — MAP: frames entrants → ctx.session.prompt/synthetic
│                      (delivery steer/queue), batching, accusés.
├── hooks.ts          — tool.execute.before / permission.evaluate (réservations),
│                      event subscribe (activité optionnelle).
└── (aucune modification de src/extension/)
```

*Les deux adaptateurs sont à niveau égal* : le Pi s'appuie sur
`src/extension/`, OpenCode sur `src/extension-opencode/` — aucun des deux
ne doit importer l'autre, et les deux exposent la même surface (mêmes
outils, mêmes commandes, mêmes statuts). Aucun fichier de `src/extension/`
ne doit être touché (le portage y est strictement additif) : la réutilisation
passe par l'import des modules existants (guards, batching, format des
inbound…), jamais par une copie. La duplication du *contrat* (comme
`pi-types.ts` existe déjà pour Pi) se fait ici par import direct des types
`@opencode-ai/plugin` — pas de miroir local.

Points d'attention :

- **Zéro dépendance runtime supplémentaire au niveau du cœur.** Seul le
  paquet d'adaptateur introduit `@opencode-ai/plugin` en *peer/optional*
  (l'utilisateur qui n'utilise pas OpenCode n'a pas à l'installer).
- Le même `dist/src/client`, `dist/src/broker`… est partagé : l'adaptateur
  réutilise les modules existants (MeshClient déjà importé par la CLI).
- La version de `@opencode-ai/plugin` installée chez vous est **1.x** (V1 :
  hooks `chat.message`, `tool.execute.before`, … exposés via la fonction
  `Plugin`). La **V2** (`Plugin.define` + `setup(ctx)`) est documentée et
  supportée par la même version du paquet depuis la 1.16+ (le schéma
  `Config.plugin` accepte les deux formes — votre `opencode.json` utilise
  déjà la clé legacy `plugin`). Le plan prévoit donc un **plugin double mode**
  (V1 + V2 dans le même `default export`), exactement le pattern décrit
  « Support V1 » des docs V2, ce qui fonctionnera avec la version 1.15.4
  déjà présente chez vous **sans rien installer**.

### 2.3.2 Cycle de vie d'une session (identité, alias, reconnect)

C'est la partie la plus proche du câblage Pi existant, et la plus
directement réutilisable :

1. À l'instanciation du plugin (setup), rien de session n'est connu :
   chaque session OpenCode démarre son propre lifecycle.
2. Lorsqu'une session OpenCode démarre (sessionID connu — l'identifiant est
   stable, comme chez Pi), le plugin construit un `MeshClient` :
   - alias : celui de la config (`MESH_ALIAS` / config.json) ou, à défaut,
     tiré du fichier de persistance `identity-<sessionID>.json` (mécanisme
     existant, réutilisé tel quel) ;
   - rooms : identiques à l'identité persistée ;
   - réservations : réutilisées, avec le même TTL.
3. Le client se connecte ; le broker **auto-spawn** (déjà implémenté) ;
   le hello déclare alias + rooms — comportement identique à Pi.
4. À la fermeture de session (`session_shutdown` côté OpenCode, équivalent
   V2 de `session_shutdown` Pi) : persister l'identité (même appel que
   `saveIdentity`), annuler les timers, fermer le client.
5. Un `/mesh alias X` équivalent : un *command* OpenCode permet de renommer
   l'alias en cours (`client.rename`), puis persist.

Aucun des points ci-dessus n'utilise d'API inédite : ils sont déjà testés par
le mode Pi, et l'identifiant de session est exposé par le SDK OpenCode de la
même façon qu'à Pi (`sessionID`).

### 2.3.3 Injection des messages entrants

C'est le cœur du système et c'est là que le mapping est le plus riche —
mais il est maîtrisable :

- Le `MeshClient` émet déjà les frames (mêmes callbacks qu'en mode Pi) ; le
  nouvel adaptateur les consomme exactement comme `attach.ts`/`inbound.ts`
  le font aujourd'hui (le *contenu* des messages est construit dans
  `extension/inbound.ts`, pure logique exportée et testée sans Pi — elle
  peut être réutilisée **directement**).
- Pour chaque frame entrant destiné à la session `S` :
  1. calculer le mode de livraison, comme aujourd'hui : `normal` →
     `delivery: "queue"` (attente le prochain prompt utilisateur) ;
     `urgent` → `delivery: "steer"` (interrompt le tour en cours) ;
     `force` → `interrupt` via `ctx.session.interrupt` puis
     `delivery: "steer"`.
  2. appeler `ctx.session.prompt({ sessionID: S, text, delivery })`.
     - `"queue"` : le message attend le prochain prompt (le comportement de
       Pi `followUp`).
     - `"steer"` : OpenCode interrompt le tour en cours (équivalent du
       `triggerTurn`/steer de Pi).
- L'annonce « wake‑on‑answer » fonctionne donc naturellement : un message
  injecté déclenche un nouveau tour si la session est idle — exactement le
  contrat attendu par les missions `awaitReply`.
- Le **batching** (les frames arrivant pendant un long tool call sont
  regroupés en un seul message) est purement applicatif : l'adaptateur sait
  quand le tour est occupé — OpenCode ne l'expose pas directement, mais le
  plugin peut connaître l'état du tour via les hooks `context` (déjà
  disponibles, voir §2.6). Le regroupement lui-même reste implémenté par
  pi-mesh.
- Le **déferred inbox** (`inboundBroadcasts: "deferred"`) est purement local :
  réutilisé tel quel.
- Les **accusés de lecture** (`read` receipts) n'ont pas d'équivalent : OpenCode
  n'observe pas « le moment où l'utilisateur a lu le message ». Le plugin
  pourra mesurer ce qu'il peut (nombre d'injections par session, horodatage)
  mais pas l'activité humaine. C'est documenté comme limitation, pas comme
  bloquant.
- `ctx.session.synthetic` existe aussi (messages transitoires, sans passer
  par le chemin utilisateur). À réserver aux cas où le portage voudrait
  distinguer strictement « injecté comme user message » (suivant le modèle de
  Pi, les messages entrants sont des user messages : `prompt` est donc le bon
  choix).

### 2.3.4 Interrupt / unblocking (`force` + `interrupt`)

C'est le point où OpenCode est **le plus proche** de Pi, et le portage peut
réutiliser la machine de tests existante :

- Envoi avec `priority: "force"` + `interrupt: true` : l'adaptateur appelle
  `ctx.session.interrupt({ sessionID, continue: false })` sur le client
  cible, exactement comme le `abort()` de Pi déclenché aujourd'hui.
- OpenCode s'occupe alors de tuer le processus du tool bloqué (même
  mécanisme que pour un utilisateur qui appuie sur ESC dans le TUI) ;
  pi-mesh n'a plus à dupliquer cette logique — elle est déjà testée côté
  hôte et non re-développée.
- Le **reçu honnête** de l'interruption (« turn aborted / still busy /
  abort_unavailable ») : après l'appel, le plugin peut attendre un court
  laps de temps et interroger l'état du tour. S'il n'y a pas d'API exposée
  pour connaître l'état d'un tour, la réception peut être supposée par
  défaut (le tour est interrompu ou terminé) — la limitation reste documentée,
  et le mode `receipt` reste disponible côté *envoi* (le sender reçoit bien le
  statut, transmis par pi-mesh lui-même).
- La politique (`forceAllowedFrom`, `deny`, `rateLimits`, `forcePerMin`)
  reste évaluée **côté broker** (`policy.ts`, réutilisable) : OpenCode n'a
  rien à ajouter ; seul le déclenchement de l'interruption est hôte.

### 2.3.5 Permissions et réservations de fichiers

- Les **réservations** (`mesh_reserve` / blocage d'`edit`/`write`) ont un
  équivalent naturel : `ctx.permission.hook("evaluate")`. OpenCode évalue
  déjà ses propres règles de permission ; le plugin peut y ajouter une règle
  « deny » lorsque le chemin est réservé par un autre alias. C'est le seul
  mécanisme que OpenCode propose pour *bloquer* une action, et il est
  documenté avec `event.effect = "deny"`.
- Le hook est optionnel : si l'utilisateur n'active pas le mesh, rien ne change.
- Les sélections de fichiers par l'agent passent par le même `edit`/`write`
  tools natifs d'OpenCode ; le plugin observe les *appels* d'outils via
  `ctx.tool.hook("execute.before")` pour y lire les chemins ciblés, puis
  refuse via la règle de permission.

### 2.3.6 Activité, statut et accusés de lecture (read receipts)

- Présence et état de tour (« busy/idle/stuck ») : le broker observe déjà
  les heartbeats (`lastSeenAt`) et pi-mesh calcule `idle`/`stuck` de façon
  déterministe (`computePeerStatus`). Le mode Pi ajoute une annonce en temps
  réel via les événements ; sous OpenCode, l'équivalent direct existe via
  `ctx.event.subscribe`, mais n'est pas indispensable : la détection
  paresseuse (sur le dernier heartbeat) reste exactement ce que la CLI
  observe déjà. Le plugin peut tenter d'annoncer `busy` depuis le hook
  `context` (début de tour) ; la partie `idle` est implicite (le statut est
  recalculé à la demande).
- `mesh_status` : l'outil expose le même snapshot construit par
  `status_req` — réutilisable sans changement.
- Accusés de lecture : sans surface utilisateur, le plugin suit au mieux ce
  qu'il peut (injections reçues par session) ; l'information reste en interne
  pour le *sender*. Limitation acceptée (cf. 2.3.3).

### 2.3.7 Skills et documentation agent-facing

- Le skill `mesh-coordination/SKILL.md` est un fichier Markdown chargé à la
  demande par les agents — le format est **hôte‑agnostique**. OpenCode le
  charge depuis `skills/` (dossier `.opencode/skills/` ou config
  `skills`).
- Le plus simple : OpenCode charge le même répertoire du paquet installé
  (npm installe le dépôt sous `node_modules/pi-mesh-extension/`), ou la
  config `skills` pointe sur le même dossier ; la documentation décrit les
  mêmes règles d'or (reply once per msgId, launch → wait_all, anti-boucle…).
- Aucune adaptation de contenu n'est requise pour le *contenu* du skill ;
  seule la référence aux outils doit rester cohérente (noms de tools
  inchangés : `mesh_send`, …).

### 2.3.8 Différences d'UI : renderer, HUD, couleurs

**Perte assumée, et justifiée par l'absence d'API.**
- OpenCode V2 ne propose ni registre de « custom message renderer », ni
  widget HUD pour plugins (seul un *transform* de contenu des messages est
  exposé). Les entrants `[mesh] @from …` seront donc rendus comme des messages
  utilisateur standards, sans couleurs par alias.
- Le format compact utilisé (`contextVerbosity: "compact"`) reste lisible et
  reste exploitable : le plugin OpenCode peut injecter exactement le même
  texte construit par la logique pure de `inbound.ts`.
- Les fonctionnalités UI de pi-mesh (`registerMessageRenderer`,
  `registerEntryRenderer`, `MeshHud`) ne sont **pas dupliquées** : leur
  rôle (feedback visuel) est remplacé par le rendu natif d'OpenCode, que
  l'utilisateur connaît déjà.
- À terme (optionnel, phase suivante), surveiller si OpenCode expose de
  nouveaux hooks de rendu ; jusqu'ici, le plan se contente d'accepter la
  perte plutôt que de polluer le rendu utilisateur.

## 2.4 Intégration utilisateur et packaging

Deux questions de packaging décident du mode d'usage, et sont posées comme
décisions à valider (§2.7) :

1. **Un seul paquet pour les deux hôtes.** Pi et OpenCode sont tous deux
   des hôtes d'agents ; distribuer un seul paquet `pi-mesh-extension` qui
   expose *deux* entrypoints (un pour Pi via le champ `pi` de
   `package.json`, un pour OpenCode via le champ/plugin configuré) évite la
   double installation et la double mise à jour. La contrainte : les champs
   de manifest sont distincts (Pi lit `pi.extensions`/`pi.skills`, OpenCode
   lit la config `plugins`/`skills`) — c'est exactement le pattern « support
   both » décrit dans les docs V2 (`Plugin.define` + `server()`).
2. **Deux paquets séparés.** Plus simple à maintenir (chaque hôte ne
   dépend que du plugin dont il a besoin) au prix de deux installations.

Dans les deux cas, le **cœur** reste partagé (mêmes sources, même build) :
c'est la dépendance de `package.json` sur `@mariozechner/pi-tui` (uniquement
pour le renderer Pi) qui impose à un paquet commun d'avoir ce peer ; le paquet
OpenCode traiterait `@opencode-ai/plugin` comme peer optionnel à part.

Le broker sert dans les deux sens — **Pi → OpenCode comme OpenCode → Pi** — et
c'est justement ce sens inverse qui motive l'intégration : les sessions Pi
s'ouvrent sur les messages injectés par une session OpenCode, exactement comme
les sessions OpenCode s'ouvrent sur celles injectés par des sessions Pi.

Actuation côté utilisateur (le plus simple à documenter) :

```jsonc
// ~/.config/opencode/opencode.json (ou projet)
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "pi-mesh-extension", "options": { "alias": "…" } }
  ]
}
```

- Activer le mesh **globalement** (un seul broker partagé entre toutes les
  sessions OpenCode de la machine) ou **par projet** selon l'usage voulu —
  c'est une question de préférence, pas de capacité.
- `MESH_*` / `.mesh/config.json` fonctionnent exactement comme sous Pi : la
  config est lue par le même `loadConfig`.

## 2.5 Plan d'implémentation en phases

| Phase | Contenu | Livrables | Critères de sortie |
|---|---|---|---|
| **0 — Fondations** | dossier `src/extension-opencode/` ; types ; câblage plugin minimal (setup/teardown) ; build vérifié. Aucune logique métier. | dossier créé, `tsc` vert, plugin chargeable (setup exécuté). | `npm run build` passe ; pas de changement sur les fichiers existants. |
| **1 — Outils & commandes** | `register-tools.ts` (8 outils, mêmes descriptions) ; `register-commands.ts` (`/mesh …`) ; runtime par session (client, alias, identité). | outils appelables et fonctionnels tête-à-tête (send→delivered) ; `/mesh` opérationnel. | test manuel : deux sessions OpenCode se voient (démo smoke). |
| **2 — Injection & orchestration** | `inbound.ts` réutilisé (logique pure) ; mapping prompt/steering ; batching ; accusés ; wake-on-answer ; `awaitReply` + `mesh_wait_all` en attente de verdict. | un message envoyé depuis une session arrive et déclenche le tour ; `mesh_wait_all` suspend jusqu'à la verdict ou timeout. | scénario orchestrateur complet (cf. README) testé entre deux sessions. |
| **3 — Hooks d'hôte** | `tool.execute.before` (réservation) ; `permission.evaluate` ; `interrupt` (`ctx.session.interrupt`) ; `event.subscribe` pour l'activité (best-effort). | un `edit`/`write` sur une réservation est bloqué ; un agent bloqué est réveillé par `force`+`interrupt`. | tests d'integration hôte (voir §2.6). |
| **4 — Différences résiduelles** | perdus assumés : renderers TUI, HUD, accusés de lecture UI. Documentation utilisateur des limitations. | README/plan mis à jour ; résumé « limitations connues » dans la doc. | aucun code à ajouter pour les capacités perdues. |
| **5 — Packaging & diffusion** *(optionnelle)* | champ manifest opencode / configuration ; publication éventuelle ; relecture du skill pour OpenCode ; release. | plugin installable via config utilisateur ; docs mises à jour. | facultatif — dépend de la décision packaging (2.4). |

Ordre conseillé (chaque phase dépend de la précédente pour l'injection et
les hooks), mais phase 1 peut démarrer seul (outils + status).

## 2.6 Tests

- **La suite existante reste verte et est réutilisable à ~100 %** : les tests
  `node --test` de pi-mesh couvrent le broker, le client, la logique
  d'injection (`inbound.ts` pur), la persistance d'identité, etc. — sans
  aucune référence à Pi (seuls les tests d'adaptateur ont besoin d'un hôte).
- **Nouveaux tests limités au adaptateur** : charger le plugin dans un hôte
  minimal (un `PluginInput` factice ou un petit serveur OpenCode de test),
  vérifier l'enregistrement des outils/commandes, et vérifier que le
  runtime par session injecte correctement. OpenCode n'expose pas de test
  harness public documenté pour plugins ; l'approche recommandée est donc de
  tester le *cœur* de l'adaptateur (runtime, mapping inbound, hooks) en
  le branchant sur un MeshClient factice, sans serveur OpenCode.
- **Tests d'acceptation manuelle** (deux sessions OpenCode) reste le critère
  le plus fidèle au mode d'usage : scénario « hello, send, reply, wait_all ».

## 2.7 Points de décision à valider

1. **Un seul paquet ou deux ?** — recommandation : un seul paquet (champ
   `pi` + plugin OpenCode), le cœur étant partagé ; mais deux paquets est
   acceptable si la contrainte de peer-dependency `@mariozechner/pi-tui`
   est jugée trop lourde. À trancher avec vous.
2. **Activation : global ou par projet ?** — recommandation : global par
   défaut (c'est le modèle multi-agent du mesh), avec possibilité par
   projet.
3. **Announce d'activité en direct sous OpenCode** : tenter via
   `ctx.event.subscribe` / hook `context` (busy), ou se contenter de la
   détection paresseuse ? Recommandation : best-effort, phase 1.
4. **Le reçu « interrupt » après `ctx.session.interrupt`** : supposer
   l'interruption (pas d'API pour observer le tour) ou attendre un état ? Le
   premier est honnête et simple ; le second bloque la phase. Recommandation :
   supposer.
5. **Perte des renderers/HUD** : acceptée sans recours ? (le plan suppose oui;
   l'API plugin V2 n'en offre pas d'équivalent aujourd'hui).
6. **Perte des accusés de lecture UI** : acceptée sans recours (limitation
   documentée, info en interne conservée).

---

*Voir aussi : `README.md` (usage Pi/CLI), `CLI-PLAN.md` (historique du CLI),
`INTERRUPT-PLAN.md` (force + interrupt).* — ce document n'a été ajouté ni
modifié d'aucun fichier existant.
