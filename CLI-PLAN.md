# Plan CLI pi-mesh — analyse & feuille de route détaillée

> **Statut : implémenté et releasé en v0.7.1 (2026-10-04)** — Phases 0-6
> complètes, Phase 7 arbitrée (`shell` retiré, `attach` couvre). Chaque phase
> a été reviewée par un agent pair (voir Annexes) avant intégration. Les
> vérifications npm (noms libres/pris) datent de cette release.

> Objectif : faire de `src/cli/mesh.ts` (309 lignes, debug/admin) une vraie CLI
> **sans trahir un seul invariant du projet**. Chaque décision ci-dessous est
> tracée vers la vision du README/CONTRIBUTING.

---

# PARTIE 1 — ANALYSE DÉTAILLÉE DE PI-MESH

## 1.1 Vision — les invariants cardinaux (source de vérité)

Extraits du README + CONTRIBUTING, reformulés en règles vérifiables :

| # | Invariant | Source |
|---|---|---|
| V1 | **Statuts honnêtes** : `delivered ≠ read ≠ answered`, `queued_offline`/`dropped_offline`/`expired` explicites, jamais un statut gonflé | README "Honest statuses", CONTRIBUTING "Honesty is a feature" |
| V2 | **Ledger hash-only** : aucun body persisté hors transcript opt-in ; scan fail-closed des clés interdites | README, CONTRIBUTING règle 4 |
| V3 | **Zéro dépendance runtime** : Node ≥ 20 pur, ESM/NodeNext, strict tsc ; pi-tui en peer/dev uniquement | package.json, CONTRIBUTING |
| V4 | **Couches sans fuite** : `protocol → broker → client → extension` ; les 3 premières n'importent jamais Pi | CONTRIBUTING "Project shape" |
| V5 | **Tout bound = constante nommée** dans `src/shared/config.ts` | CONTRIBUTING |
| V6 | **Zéro boucle** : rate caps client+broker, fenêtre anti-duplicate, self-send block, reply dedup, ack-of-ack guard, `force` exige une reason | README "Reliability" |
| V7 | **Broker stateless & jetable** : kill n'importe quand, re-hello + re-déclaration, auto-spawn par lockfile | README |
| V8 | **Windows first-class** : named pipes au lieu d'AF_UNIX | README "Platform notes" |
| V9 | **Multi-machine** : TCP/TLS + token partagé, dual listen (unix local tokenless + réseau), tout marche à l'identique | README v0.4.18+ |
| V10 | **One tool = one action** ; les besoins déterministes méritent un outil, les patterns soft des conventions | CONTRIBUTING |
| V11 | **Commenter le POURQUOI**, pas le quoi ; pas de codes de tracking | CONTRIBUTING |

## 1.2 Architecture constatée (v0.7.0, 405 tests verts)

```
src/
├── protocol/   frames.ts (69 l.)   NDJSON, sha256, makeMsgId, FrameDecoder
│               envelope.ts (533 l.) MeshFrame, 18 types de frames, 20 codes
│                                    d'erreur, validation, alias/room regex,
│                                    forbidden-keys scan, buildFrame
├── broker/     broker.ts (1011 l.)  dispatch frames, dual listen unix+tcp/tls,
│                                    token hash, ack honest, reservations
│               mailbox.ts (92 l.)   cap 100 / TTL 1 h, drop notices
│               rooms.ts (146 l.)    presence, join/leave, snapshot, cap 64/room
│               ratelimit.ts (76 l.) buckets msg 30/min, urgent 15/min, force 1/min
│               policy.ts (120 l.)   allow/deny declaratif, forceAllowedFrom
│               state.ts (68 l.)     BrokerState, PeerRecord
├── client/     client.ts (1724 l.)  MeshClient : connect (auto-spawn via
│                                    ensureBroker), send/reply/reserve/release/
│                                    status/join/leave/rename/waitAll/close,
│                                    activity, read receipts, missions LAUNCH,
│                                    alias_taken fallback, watchdog offline
│               reconnect.ts (206 l.) backoff expo 250ms→5s, connectProbe(Tcp),
│                                    ensureBroker (spawn detached + lock)
│               pending.ts (117 l.)  PendingReplies (reminds ≤ 2, expiry)
├── extension/  20 modules (~4900 l.) tools, /mesh commands, HUD, inbound
│                                    (batching 250ms), guards (edit/write vs
│                                    réservations), ledger, transcript opt-in,
│                                    watchdog contexte, deferred inbox,
│                                    renderer couleurs, identity persistée
├── cli/        mesh.ts (309 l.)     ← objet du plan
└── shared/     config.ts (346 l.)   TOUTES les bornes + loadConfig(env>file)
               paths.ts (84 l.)      runtimeDir $TMPDIR/mesh-<uid> (pipe win32),
                                    stateDir <cwd>/.mesh
               version.ts            MESH_VERSION (⚠ drift, voir 1.5)
```

Points structurants :
- La CLI actuelle est **un 5e consommateur du MeshClient** (comme l'extension),
  jamais une réimplémentation du protocole. C'est le bon squelette à garder.
- `connect()` **auto-spawn le broker local** (ensureBroker) sauf si
  `brokerUrl` est défini (remote). La CLI hérite donc déjà du comportement
  "aucun daemon management".
- Aliases CLI éphémères `cli-<rand6>` (ALIAS_RAND_CHARS=6), `noReconnect: true`.
- `loadConfig(stateDir())` + env : la CLI atteint les brokers tcp/tls remote
  exactement comme l'extension (README le promet déjà).

## 1.3 Le CLI actuel — inventaire précis

Commandes **réellement dispatchées** dans `main()` :
`broker start|stop|status`, `peers [--room]`, `send <alias> <texte>
[--room] [--await] [--timeout]`, `tail`, `doctor`.

### Défauts et bugs constatés (preuves dans le code)

| # | Constat | Gravité | Preuve |
|---|---|---|---|
| B1 | `cmdRoom()` et `cmdReserve()` **existent mais ne sont jamais appelés** : `mesh join`/`leave`/`reserve` tombent dans `default:` → usage + exit 2. Or le README promet « The CLI (`mesh doctor\|peers\|send\|reserve\|join`) honors MESH_BROKER_URL » | **Bug réel** (contrat README rompu) | `main()` switch ; lignes 163/198 définies, jamais dispatchées |
| B2 | `tail` est documenté « follows the local hash-only ledger » mais ne fait qu'imprimer les 20 dernières lignes — pas de follow | Doc mensongère | `cmdTail()` lit tout le fichier, `slice(-TAIL_LINES)` |
| B3 | `reserve` dort 1,5 s puis ferme la connexion → **la réservation meurt avec la connexion** (les réservations sont scoped à la connexion, re-déclarées au hello). Un one-shot CLI ne peut donc PAS détenir durablement un claim | Sémantique incohérente | `cmdReserve()` : `setTimeout(1500)` puis `close()` |
| B4 | Aucun `bin` dans package.json → pas d'exécutable ; il faut `node dist/src/cli/mesh.js`. `npx pi-mesh-extension` ne marche pas non plus (pas de bin) | Ergonomie | package.json |
| B5 | Usage partiellement en français (« texte »), style des messages incohérent (retours à la ligne littéraux `` ` `` dans stderr vs `\n` interprétés) | Cosmétique | cmdRoom/cmdSend |
| B6 | Drift de version : package.json `0.7.0` vs `MESH_VERSION = "0.5.3"` — `/mesh broker` affiche donc une version fausse ; la détection de skew inter-pairs est faussée | **Bug réel** | version.ts vs package.json |
| B7 | **Zéro test CLI** (47 fichiers de test, aucun sur `src/cli/`) | Couverture | `test/` |
| B8 | Pas de `--json` (orchestrateurs/scripts obligés de parser du texte), exit codes binaires (0/1/2) sans distinction expired/timeout/blocked | Évolutivité | printResult() |
| B9 | `send` n'expose ni `--priority`, ni `--reason`, ni `--refs`, ni `--reply-to`, ni `--broadcast` : la CLI ne couvre qu'une fraction de `SendOpts` | Parité | cmdSend() |
| B10 | Alias éphémère recréé **à chaque invocation** : `--await` fonctionne (le process vit), mais impossible d'avoir une identité CLI stable sans flag | Design | cliAlias() |
| B11 | **La CLI viole V5** : `TAIL_LINES = 20` et `CLI_SEND_TIMEOUT_MS = 30_000` sont hardcodés en tête de `mesh.ts` au lieu de vivre dans `shared/config.ts` | Bug règle CONTRIBUTING | mesh.ts L18-19 |
| B12 | `expired` → exit **0** dans cmdSend (seuls `error`/`blocked` → 1) : sortie malhonnête pour les scripts | V1 rompue | cmdSend() return |

### Noms npm vérifiés (registre, aujourd'hui)
- `mesh` → **pris** (v7.0.3, lib streams) ; `pi-mesh` → **pris** (v0.2.3, autre projet)
- `pimesh` → **libre** ; `pi-mesh-cli` → **libre** ; le package reste `pi-mesh-extension`

---

# PARTIE 2 — PLAN ULTRA DÉTAILLÉ DE LA CLI

## 2.0 Principes directeurs (dérivés de la vision, non négociables)

1. **La CLI est un client MeshClient comme un autre** — zéro réimplémentation du
   protocole, zéro accès direct aux internals du broker. Toute feature CLI =
   appels existants (`send/reply/status/reserve/…`) ou lecture de fichiers
   existants (ledger, lock, config).
2. **Honnêteté en sortie et en exit code** (V1) : chaque commande imprime le
   statut exact (`delivered`, `queued_offline`, `reply`, `expired`,
   `blocked: <reason>`), jamais "ok" générique. Les exit codes distinguent
   delivered / queued / blocked / expired / usage.
3. **Zéro nouveau corps persisté** (V2) : la CLI ne crée AUCUN fichier
   contenant des bodies. Elle lit le ledger hash-only tel quel. Pas de
   cache, pas d'historique CLI local.
4. **Zéro dépendance runtime** (V3) : pas de commander/yargs/chalk. Parseur
   d'arguments maison (~150 l.), ANSI maison avec `NO_COLOR`/`TERM=dumb`/
   détection pipe + `--no-color`.
5. **Cross-platform & remote d'office** (V8, V9) : named pipes win32 via
   `socketPathForDir` (déjà le cas), `MESH_BROKER_URL/TOKEN`/config.json déjà
   gérés par `cliConfig()` — à préserver dans le refactor.
6. **Bornes nommées** (V5) : toute nouvelle constante (timeout CLI par défaut,
   taille de tail, etc.) va dans `shared/config.ts`.
7. **La CLI n'est pas une session Pi** (conséquence V1) : les commandes
   one-shot **n'émettent jamais de frame `read`** (une impression terminal
   n'est pas une lecture par un agent). **Exception D10.1** : `attach`
   interactif (TTY) émet `read` au rendu — la surface destinataire existe
   alors pour de vrai. Les read receipts one-shot restent le privilège de
   l'extension. Documenté dans `--help`.
8. **Broker management = ce qui existe** (V7) : on garde `broker
   start|stop|status` (spawn détaché + lockfile). Pas de superviseur, pas de
   foreground `-f` du broker (le broker tourne détaché par design).

## 2.1 Décisions de design (ADR)

### D1 — Nom du binaire : `pimesh`
- `mesh` et `pi-mesh` sont pris sur npm → collision de bins à éviter.
- bin : `"pimesh": "dist/src/cli/mesh.js"`. Alias documenté `mesh` non fourni.
- Le fichier d'entrée reste `src/cli/mesh.ts` (chemin déjà documenté).

### D2 — Distribution : un seul package, deux usages
- `npm i -g pi-mesh-extension` → expose `pimesh` (bin).
- `pi install npm:pi-mesh-extension` (usage Pi) **ne met pas le bin dans le
  PATH** (installs pi ≠ installs npm) → documenter `npx pi-mesh-extension …`
  comme fallback (npm exécute le bin du package sans install global).
- Vérif CI : `npm pack` → `npx` sur l'archive → `pimesh doctor`.

### D3 — Identité CLI : éphémère par défaut, `--alias` optionnel
- Défaut inchangé : `cli-<rand6>` (honnête : un outil ponctuel n'usurpe pas
  une identité, pas de `alias_taken` sur un nom humain).
- `--alias <name>` (+ `--room` répétable) pour les usages scriptés durables ;
  collision → l'erreur `alias_taken` du broker remonte telle quelle.
- **Pas** de persistance d'identité CLI (jamais de fichier identity-CLI) : V2
  et sobriété ; l'alias est fourni par l'humain ou le script.

### D4 — Sorties : humain par défaut, `--json` partout en lecture
- Sortie texte : statut honnête + ids, couleurs ANSI par agent pour `watch`
  (même hash→couleur que `extension/colors.ts`), désactivées si pipe/NO_COLOR.
- `--json` : un objet JSON par ligne (NDJSON) pour les commandes de lecture
  (`peers`, `status`/`stale`, `doctor`, `ledger`, `tail`, `wait`, `send`) —
  jamais de bodies en plus que ce que MeshClient retourne déjà.

### D5 — Exit codes (contrat stable, documenté, testé)
| code | sens |
|---|---|
| 0 | succès honnête (`delivered`, `queued_offline`, `reply`, verdict complet) |
| 1 | échec mesh : `blocked:<reason>`, `error:<reason>`, broker injoignable |
| 2 | usage (arguments invalides) — stderr = usage, stdout vide |
| 3 | `expired` / timeout d'attente (`--await`, `wait`, `ping`) |
| 4 | résultat partiel honnête : broadcast `deliveredCount < totalCount`, `wait` verdict `timeout`/`cancelled` avec réponses reçues, **`queued_offline`** (rien n'est livré — exit 0 serait un mensonge pour les orchestrateurs) ; `--require-online` fait sortir `queued_offline` en 1 pour les scripts stricts |

### D6 — Pas de mode TUI lourd ; un `watch` en mode observateur
- `pimesh watch` : client persistant `role: observer`, imprimant les frames
  (presence, ack, activity, msg hash-only — jamais les bodies) en continu.
  Debug live sans Pi, zéro token LLM, Ctrl-C propre. Réutilise `onFrame`.
- Pas de REPL d'envoi dans la v1 de la CLI (le REPL, c'est une session Pi ;
  `send -` lit stdin pour composer par script). ⚠ Nuance D10 : `attach`
  introduit un REPL **destinataire** (recevoir + répondre), pas un TUI lourd
  — readline seul, pas de rendu plein écran ; la règle « pas de TUI lourd »
  tient.

### D7 — `--alias` explicite désactive le fallback `alias_taken`
- MeshClient retente puis **retombe sur un alias aléatoire** en cas de collision
  (comportement voulu pour une session Pi). Pour la CLI, une identité surprise
  serait malhonnête : avec `--alias` fourni, le fallback est désactivé et la
  collision sort `blocked:alias_taken` en exit 1. Sans `--alias` (éphémère),
  le fallback reste actif — peu importe, l'alias n'a pas de sens humain.

### D8 — Rédaction ABSOLUE des bodies (leçon review)
- `observer_readonly` bloque l'ENVOI par un observer, **pas la réception** : un
  `send --to <watcher>` ou un reply ciblé LIVRE un body au watcher. Donc
  « watch n'affiche jamais de bodies par construction » est FAUX — la règle
  devient : **aucune commande CLI n'imprime jamais un body AUQUEL ELLE N'EST
  PAS ADRESSÉE, ni texte ni `--json`** (un script qui teerait stdout ne
  fuitera rien). `watch` affiche `bodyHash` ; `send --json` ne renvoie que
  statuts/ids/compteurs. ⚠ Nuance D10 : `attach` est un **destinataire** —
  les bodies qui lui sont adressés s'affichent (règle unifiée : ne jamais
  imprimer un body qui ne vous est pas adressé).

### D9 — Sécurité minimale
- Token : uniquement env/config (`MESH_BROKER_TOKEN`, config.json) — **jamais
  de flag `--token`** (exposition `ps aux`). `config show` imprime
  `token: set (sha256:<8>)`.
- `broker stop` : le broker local est partagé par toutes les sessions Pi
  actives → garde obligatoire : refuse avec la liste des pairs connectés
  (via status) sauf `--force`.
- `reserve --hold` : plafonné sous `DEFAULT_RESERVATION_TTL_MS` (6 h),
  countdown affiché, release propre SIGINT/SIGTERM (y compris émulation
  win32) — tests dédiés anti claim-zombie.
- `send --priority force` depuis la CLI : le help rappelle les rate caps
  broker (30/15/1 par min) et l'exigence `--reason`.

### D10 — Standalone peer : un pair SANS session Pi (`attach`)
- Besoin utilisateur : « utiliser ou créer un mesh en mode vide — non lié à
  un agent, juste recevoir + pouvoir envoyer » ; et reprendre l'identité
  d'une session Pi morte (killée) pour la continuer en mode sans session.
- **Nom retenu : « standalone peer »** (pair autonome). Rejetés : « empty
  agent » (vide de quoi ?), « ghost/phantom » (whimsical), « detached »
  (déjà pris : le broker détaché), « headless » (l'humain EST devant le
  terminal), « relay » (suggère un proxy). « Standalone » dit exactement
  ce que c'est : un pair complet du mesh qui se tient seul, sans session.
- Commandes : `pimesh attach` (créer/rejoindre en standalone) et
  `pimesh sessions` (lister les identités persistées). L'adoption d'une
  session morte = `attach <alias>` / `attach --session <id>`.
- **Zéro changement de protocole** : un standalone peer est un MeshClient
  ordinaire (member, alias, rooms, réservations) — le broker ne fait aucune
  différence. Toute la feature vit dans la couche CLI + un déplacement de
  code pur (identity store → shared/).

### D10.1 — Sémantique honnête du standalone peer
- **Bodies autorisés À L'ÉCRAN** : contrairement à `watch` (D8), `attach`
  EST un destinataire — les messages qui lui sont adressés s'affichent AVEC
  leur body. La règle unifiée : « jamais n'imprimer un body qui ne vous est
  pas adressé » ; watch = surface de monitoring → hash seulement ; attach =
  surface destinataire → body affiché.
- **Read receipts étendus honnêtement** : `attach` émet un frame `read`
  uniquement quand un message est rendu sur un TTY interactif
  (l'équivalent terminal de « injecté dans une session » — le contenu a
  atteint la surface d'attention du destinataire). Jamais en `--json` ni
  quand stdout est pipé/redirecté (un pipe n'est pas une surface
  d'attention) ; opt-out `--no-read`. Sémantique documentée dans le README :
  `delivered` (socket) → `read` (surface destinataire : session OU
  terminal interactif) → `answered` (reply explicite).
- **Pas d'annonces d'activity** : pas de session = pas de busy/idle de tour.
  Les pairs voient l'heuristique idle ; si le standalone tient des
  réservations adoptées et reste idle > stuckMs, il est flaggé `✕ stuck` —
  HONNÊTE (un détenteur de claims qui ne progresse bloque bien les autres).
- **Adoption = vol documenté** : si la session Pi d'origine revient, elle
  retombe sur un alias aléatoire avec notification (comportement existant
  alias_taken → fallback). L'adoption hérite : alias, rooms, réservations
  (celles de moins de 24 h, règle existante) et **la mailbox** — les msgs
  `queued_offline` envoyés à l'alias mort sont flushés au hello de
  l'adoptant.

## 2.2 Surface de commandes cible (mapping extension ↔ CLI)

| Extension (outil//commande) | CLI | Différences assumées |
|---|---|---|
| `mesh_send` | `pimesh send <alias> <msg…>` `--room --priority --reason --refs --reply-to --broadcast --await --launch --timeout --alias` | stdin via `-` ; `--launch` = `awaitReply:true, block:false` → affiche `delivered`, mission rendue en tâche de fond **du process** (exit 0 immédiat) ; pour collecter → `pimesh wait` |
| `mesh_wait_all` | `pimesh wait [--timeout MS] [--json]` | attend les missions du **même process** — documenté : les missions sont en mémoire client (pas de file durable). Usage scripté : `send --await` synchrone ou `pimesh attach --json` / `shell` (phase 7, optionnel) |
| `mesh_reply` | `pimesh reply <msgId> <msg…>` `--to --reply-all --refs` | pareil à send |
| `mesh_status` | `pimesh status [room] [--all] [--reservations] [--json]` + alias `pimesh peers` ; `stale` = alias de `status --reservations` | affiche via=, activity ●/○/✕, versions, stats broker, réservations des pairs + âge/TTL |
| `mesh_ledger` | `pimesh ledger [--limit] [--from --to --room --event] [--json]` | lit `ledger.jsonl` (déjà hash-only), filtres identiques |
| `mesh_history` | — (N/A) | ring mémoire **session** : la CLI n'en a pas. `watch` couvre le besoin debug |
| `mesh_reserve` | `pimesh reserve <path…> [--reason R] [--hold MS]` | `--hold` plafonné < TTL 6 h (D9) ; voir 2.5 sémantique hold |
| `mesh_release` | `pimesh release [<pattern>…] [--all]` | ⚠ libère SES réservations ; `--alias` requis pour agir en opérateur ? **Non** : release ne concerne que les claims du client — documenté |
| `/mesh ping` | `pimesh ping <alias> [--timeout]` | sucre assumé sur `send --await` court (gardé : utile en debug humain) |
| `/mesh stale` | `pimesh status --reservations` (alias `pimesh stale`) | fusionné dans status (redondance évitée) |
| `/mesh join/leave/alias` | **debug-only** : `pimesh join/leave/rename` | one-shot inutile en v1 (membership scoped connexion, meurt au exit) — marqué debug-only dans help, sans tests dédiés ; le vrai join persistant vit dans `watch` |
| `/mesh broker` | `pimesh broker start\|stop\|status [--json]` | `stop` gardé par D9 (liste des pairs connectés, `--force` requis) ; status affiche endpoints dual + drift version |
| doctor | `pimesh doctor [--json]` | étendu : version CLI vs MESH_VERSION vs pairs, endpoints, token requis? |
| (nouveau) | `pimesh tail [-f] [--limit N] [--json]` | vrai follow (fs.watch + tail start) sur ledger.jsonl |
| (nouveau) | `pimesh attach [alias] [--session ID] [--json]` | **standalone peer** (D10) : recevoir AVEC bodies (destinataire), envoyer, réserver — sans session Pi ; adoption d'identité morte |
| (nouveau) | `pimesh sessions [--json]` | identités persistées (`identity-<sessionId>.json`) : alias, rooms, résa, en ligne ? — cible d'adoption |
| (nouveau) | `pimesh watch [room] [--json]` | flux de frames observateur (2.6) |
| (nouveau) | `pimesh config show` | imprime la config résolue (defaults < file < env) — jamais de secrets (token masqué `sha256:abcd…`) |
| (nouveau) | `pimesh help [cmd]` / `--help` | aide par commande, exit 0 |

## 2.3 Structure de fichiers cible

```
src/cli/
├── mesh.ts            # entry (shebang #!/usr/bin/env node) — dispatcher seul
├── args.ts            # parseur maison : specs (flag/value/repeat/positional),
│                      #   --help auto, erreurs → exit 2 avec usage
├── out.ts             # println/printlnErr, ANSI helpers, --json writer,
│                      #   NO_COLOR / pipe detection, wrap largeur terminale
├── codes.ts           # EXIT_* constants (déclarées aussi dans shared/config
│                      #   si bornes numériques : CLI_TAIL_LINES, CLI_SEND_TIMEOUT_MS…)
├── ctx.ts             # résolution config/paths/env partagée (ex-cliConfig),
│                      #   fabrique MeshClient éphémère (alias, rooms, config)
└── cmd/
    ├── broker.ts      # start|stop|status (+json)
    ├── peers.ts       # status/peers (+activity, via=, versions)
    ├── send.ts        # send/broadcast/reply/ping
    ├── wait.ts        # wait
    ├── rooms.ts       # join/leave/rename (debug-only)
    ├── reserve.ts     # reserve/release (+hold)
    ├── ledger.ts      # ledger/tail
    ├── doctor.ts
    ├── watch.ts
    ├── attach.ts      # standalone peer (D10) : REPL interactif + mode --json
    │                  #   bidirectionnel (stdout = events, stdin = commandes)
    ├── sessions.ts    # identités persistées (cibles d'adoption)
    └── help.ts
```

Aucun de ces fichiers n'importe Pi. `cmd/watch.ts` importe
`extension/colors.ts` ? **Non** — ce module est sous `extension/` ; on
_duplique_ la fonction de hash→couleur (15 l.) dans `cli/out.ts` pour garder la
frontière de couche (V4), ou on la déplace dans `shared/` (préféré :
`shared/colors.ts`, l'extension ré-importe — pure refactor sans comportement).

**Déplacement préalable (pur move, zéro changement de comportement)** :
`src/extension/identity.ts` → `src/shared/identity-store.ts`. Vérifié : le
fichier n'importe que `node:fs`/`node:path` + `protocol/` — il est déjà
layer-clean ; l'extension le ré-importe depuis shared/. Nécessaire pour que
`sessions`/`attach --session` lisent les identités sans toucher la couche
extension (V4).

## 2.4 Phases d'implémentation

### Phase 0 — Corrections préalables (avant toute feature) — ✅ implémentée (2026-10-04, 407/407 tests)
1. **Fix B1** : dispatcher `join|leave|status(room)` et `reserve` dans `main()`
   (les fonctions existent). Test de non-régression immédiat. **+ mettre à jour
   README L351** (contrat `reserve|join` promis) une fois le fix en place.
2. **Fix B6** : `scripts/sync-version.mjs` appelé par `npm run build` écrit
   `MESH_VERSION` depuis package.json (génération au build > hook `npm
   version` : pas d'oubli humain). Test CI : `MESH_VERSION === version`.
3. **Fix B2 doc** : implémenter `tail -f` (phase 3).
4. **Fix B11** : `TAIL_LINES` → `CLI_TAIL_LINES`, `CLI_SEND_TIMEOUT_MS` →
   conservé mais déplacé dans `shared/config.ts` avec les autres bornes (V5).
5. **Fix B12** : `expired` → exit 3 dès la phase 1 (D5).
6. Uniformiser la langue des messages d'usage (anglais), `\n` cohérents.

> **Suivi review (2 passes, agents 412bf0 + 2535b9, verdicts OK)** : bugs
> supplémentaires trouvés & corrigés — parse `--reason` (la valeur était
> réservée comme path fantôme ; `reasons.md` droppé), herméticité des tests
> CLI (scrub MESH_* env), CLI_RESERVE_GRACE_MS nommé, note connection-scoped
> sur join, test/version-sync.test.ts. **Dus en Phase 2** : test dédié
> B12 (expired → exit 3). **Tracé** : branche morte `status(room)` supprimée
> (peers --room couvre). Known-edge Phase 1 : `--timeout abc` → NaN,
> `--reason` final sans valeur.
- **Critères d'acceptation** : `mesh join ops`, `mesh reserve x --reason y`
  fonctionnent ; `npm test` vert ; MESH_VERSION == package.json version ;
  bornes CLI dans shared/config.ts ; README à jour.
- Effort : ~0,5 jour.

### Phase 1 — Socle (args/out/codes/ctx + dispatcher) — ✅ implémentée (2026-10-04, 423/423 tests)
- `args.ts` : API :
  ```ts
  interface ArgSpec { name: string; kind: "flag" | "value" | "repeat" | "positional";
    short?: string; help?: string; required?: boolean; default?: string | string[] | boolean; }
  parseArgs(argv: string[], specs: ArgSpec[], positionalMax?: number):
    { values: Record<string, unknown>; positionals: string[]; help: boolean }
    | { error: string }   // → usage + exit 2
  ```
  Règles : `--flag`, `--opt val`, `--opt=val`, `-o val`, `--` stop parsing,
  valeurs négatives ok, `--help|-h` partout. ~150 lignes, tests unitaires purs.
- `out.ts` : `say(line)`, `sayErr(line)`, `json(line)`, `useColor()` (TTY &&
  !NO_COLOR && !TERM=dumb && !--no-color), `dim()`, `colorFor(alias)` (hash →
  palette 8 couleurs ANSI comme l'extension).
- `codes.ts` : EXIT_OK=0, EXIT_MESH_FAILURE=1, EXIT_USAGE=2, EXIT_EXPIRED=3,
  EXIT_PARTIAL=4 (constantes nommées, V5).
- `ctx.ts` : `resolveCliConfig()` (= loadConfig(stateDir()) inchangé),
  `ephemeralClient({alias?, rooms?, extra})` → `new MeshClient({ alias: alias
  ?? cliAlias(), rooms, noReconnect: true, config })`.
- Refactor `mesh.ts` en pur dispatcher, migration des 6 commandes existantes
  vers `cmd/` sans changement de comportement (à part usage anglais).
- **Table de validation** (bornes toutes issues de `shared/config.ts`, erreur
  → usage exit 2) : `--alias` ALIAS_REGEX `^[a-z][a-z0-9-]{1,31}$` ;
  `--room` ROOM_REGEX ; `--timeout` [MIN_AWAIT_REPLY_TIMEOUT_MS=25ms,
  MAX=30 min] avec défaut CLI 30 s justifié (un script one-shot n'attend pas
  30 min — la mission longue vit dans une session Pi) ; `--refs` ≤ MAX_REFS=8,
  ≤ MAX_REF_CHARS=256 ; `--reply-to` ≤ MAX_REPLY_TARGETS=8 ; message/stdin
  1..MAX_BODY_BYTES=32 KiB (vide ou trop gros → exit 2 explicite, jamais de
  troncature silencieuse).
- `help.ts` : `pimesh help`, `pimesh help send`, `--help` par commande.
- **Tests** : `test/cli-args.test.ts` (pur), `test/cli-help.test.ts` (spawn
  `node dist/src/cli/mesh.js --help` → exit 0).
- Critères : ancien comportement intact (mêmes sorties pour doctor/peers/send
  hors nouveau formattage), 100 % des commandes avec --help.
- Effort : ~1,5 jour.

### Phase 2 — Parité send/reply/wait/rooms — ✅ implémentée (2026-10-04, 439/439 + smoke 4/4 ; corrections review intégrées)

> **Suivi review 412bf0 (OK avec réserves → tout intégré)** : strictAlias garde
> les retries transitoires (course mid-close) et ne saute que le fallback
> aléatoire ; reply --room validée au dispatch ; wait mapping D5 complet
> (complete/cancelled→0, timeout sans réponse→3, partiel→4) ; --reply-all
> ajouté (guard oneShot client : room explicite + to OU replyAll) ; re-export
> mort retiré ; hint (--require-online). **2 bugs réels trouvés en intégrant** :
> (1) les sleeps unref du client vidaient l'event loop des process one-shot →
> exit 0 menteur pendant connect() → keep-alive autour de main() ; (2) guard
> oneShot exigeait `to` — replyAll sans inbox renvoyait reply_without_target.
- `send` : exposé complet de `SendOpts` (B9) :
  `--room R`, `--priority normal|urgent|force`, `--reason` (requis si force,
  remonte `blocked:force_requires_reason` honnête), `--refs p1,p2` (≤ 8),
  `--reply-to a,b` (≤ 8), `--broadcast`, `--await` (bloquant, SIGINT →
  AbortSignal → `cancelled` en exit 0, parité v0.6 ESC), `--launch`,
  `--timeout MS` (défaut CLI_SEND_TIMEOUT_MS=30 s pour --await — un script
  one-shot n'attend pas 30 min, la mission longue vit dans une session Pi),
  `--alias`, `--require-online` (D5), message = reste des positionnels ou
  `-` (stdin complet, 1..32 KiB, exit 2 si vide/dépassement).
  **`--alias` explicite désactive le fallback `alias_taken`** (D7) :
  collision → exit 1 `blocked:alias_taken`, jamais d'identité surprise.
  ⚠ Implémentation : ajouter un flag `strictAlias` (rejectOnTaken) à
  `MeshClientOpts` — c'est du NOUVEAU code client (le fallback est codé dans
  doConnectWithAliasFallback), pas un simple câblage ; test dédié client.
  Même régime pour la RECONNEXION d'`attach` strict : si l'alias a été repris
  pendant une coupure → échec bruyant exit 1, pas de fallback silencieux.
  **`--json` ne renvoie jamais le body** (D8) : statut, msgId, compteurs.
  SIGINT : `process.on("SIGINT")` → `client.cancelAllAwaited()` → exit 0
  avec `cancelled`.
- `reply <msgId>` : `--to`, `--reply-all`, `--refs`.
- `ping <alias>` : send await timeout court (5 s) ; exit 3 si expired
  (sucre assumé, gardé — debug humain).
- `wait` : `client.waitAll(timeout)` avec missions **du même process** ;
  affichage verdict = réutiliser le format `renderVerdict` ? Non (extension) —
  format texte simple + `--json` (WaitAllSummary est déjà sérialisable).
  Sortie exit 0 complete / 3 timeout sans réponse / 4 timeout partiel.
- `join <room> [--as alias] [--observer]`, `leave <room>`,
  `alias <new>` (rename) : **debug-only** (review) — le membership meurt avec
  la connexion ; marqué tel quel dans le help, pas de tests dédiés ; le join
  persistant utile vit dans `watch`.
- **Tests** : `test/cli-send.test.ts` — broker temporaire (runtimeDir mkdtemp,
  comme smoke) + 2 process CLI `send --await` ; assert stdout
  `reply m_…: pong` exit 0 ; `--force` sans reason → exit 1
  `blocked:force_requires_reason` ; `--broadcast` → deliveredCount/totalCount.
- Effort : ~2 jours.

### Phase 3 — Observabilité offline (ledger/tail/stale/doctor/config) — ✅ implémentée (2026-10-04, 445/445 ; corrections review intégrées)

> **Suivi review 412bf0 (OK avec réserves → tout intégré)** : status utilise
> computePeerStatus() + getters client (idle/stuck sémantique extension, plus
> de 120s hardcodé) ; TTL réservations via client.reservationTtlMs (opt-out 0
> = « no-ttl » atteignable) ; **bug réel fixé** : tail -f portait un carry des
> lignes déchirées (le fragment sans \n était perdu à jamais) ; --limit invalide
> en -f → exit 2 ; watcher on(error) → arrêt honnête sans crash ; littéraux
> 20/200 du dispatcher → constantes ; --from/--to normalisés (@/casse) ; tri
> naturel des rotations (.10 > .2) ; config show + tls/maxRooms/batchMaxHold.
- `ledger` : lecture `ledgerPath(stateDir())` (les rotations
  `ledger-<date>.jsonl.N` sont listées aussi, plus récentes d'abord),
  filtres `--from --to --room --event --limit` (≤ 200, borne nommée),
  `--json` = ré-émission des lignes JSON valides (elles sont déjà hash-only —
  aucun body ne peut y figurer, invariant tenu par l'écriture).
- `tail` : `-f` avec `fs.watch` sur le dir stateDir (rotation-safe : watch le
  répertoire, pas le fichier) + re-read incrémental (offset octets, borné par
  TAIL_MAX_BACKLOG_LINES=1000) ; sans `-f` = N dernières lignes (défaut 20).
  Affiche `event from→to ts id hash` — jamais de body (il n'y en a pas).
- `stale` → intégré à `status --reservations` (alias `stale`) : `status()` +
  `reservationsOf(alias)` de tous les pairs ≠ moi, avec âge (`since`) et état
  TTL (RESERVATION_TTL_MS connu côté client pour l'affichage). `--json`.
- `doctor` étendu : endpoints (unix + tcp/tls si listen), reachable, lock
  pid/alive/STALE, config path + clés actives (alias/rooms/priority…),
  `protocol mesh.v1`, `cliVersion`, `meshVersion` (MESH_VERSION), avertissement
  si drift ; token : jamais imprimé, seulement `token: set (sha256:<8>)`.
  Exit 1 si injoignable (inchangé).
- `config show` : config résolue complète (defaults < file < env), token
  masqué. Pas de `config set` en v1 (un simple éditeur de fichier suffit —
  V10 : pas d'outil pour ce qu'un `$EDITOR` fait).
- **Tests** : `test/cli-tail.test.ts` (fixture ledger.jsonl + append pendant
  `-f` avec timeout kill), `test/cli-doctor.test.ts` (broker up → exit 0 ;
  lock périmé → STALE).
- Effort : ~1,5 jour.

### Phase 4 — Reserve honnête (B3) + watch — ✅ implémentée (2026-10-04, 452/452 + smoke ; corrections review intégrées)

> Déplacement préalable fait : extension/reservations.ts → shared/reservations.ts
> (pur, zéro import Pi — findConflict réutilisé par la CLI, sémantique
> identique aux guards edit/write).
> **Suivi review 412bf0 (OK avec réserves mineures → tout intégré)** : cap
> --hold effectif = min(CLI_HOLD_MAX, TTL configuré, refusé si ≥ — jamais
> tronqué silencieusement) ; stop() idempotent + second signal → exit
> immédiat + force-timeout 3s (broker mort ne piège plus Ctrl-C) ;
> CLI_HOLD_TICK_MS/CLI_RESERVE_SETTLE_MS nommés ; cmdRelease skip le réseau
> quand rien détenu ; renderLine prend la frame déjà redacted (défense en
> profondeur) ; DEFAULT_ROOM au lieu du littéral.
- **Sémantique reserve** (2.5 détaillé) :
  - `pimesh reserve p1 p2/ --reason "why" [--hold 3600000]` :
    sans `--hold` → **dry-run de conflit** : envoie la réservation, affiche
    les conflits détectés (`conflict: p1 held by @agent-x since 12m`), puis
    relâche immédiatement à la fermeture — la sortie dit explicitement
    `released on exit (CLI reservations are connection-scoped)`. Exit 0 si
    réservable, exit 4 si conflit (info partielle honnête).
  - `--hold <ms>` : garde le process vivant en tenant le claim (affichage
    countdown, Ctrl-C → release propre + SIGTERM handler). **Plafonné sous
    DEFAULT_RESERVATION_TTL_MS (6 h)** — `forever` retiré (D9) : le TTL
    système expirerait de toute façon le claim, l'afficher comme illimité
    serait malhonnête.
  - `release` : ne concerne que les patterns du client courant (documenté) ;
    `--all` = tout relâcher.
  - Nettoyage : handlers SIGINT/SIGTERM → `client.close()` avant exit (les
    réservations meurent avec la connexion — pas de leak). **Tests win32** :
    SIGTERM y est émulé — vérifier la release dans la matrice CI.
- **watch** : `pimesh watch [room] [--json] [--alias a]` :
  - client `noReconnect:false` (il EST le watcher : reconnexion utile),
    rejoint `room` (défaut default) **en observer** (V10 : observer = ne pas
    perturber, n'envoie rien). ⚠ Correction review : un observer ne reçoit
    pas les broadcasts, MAIS `observer_readonly` ne bloque que l'ENVOI — un
    `send --to <watcher>` ou un reply ciblé LUI LIVRE un body. La rédaction
    est donc une **règle absolue au point d'impression (D8)**, pas une
    propriété du rôle : le renderer écrase `body` avant tout affichage
    (texte ET `--json`), remplace par `bodyHash` — `pimesh watch | tee`
    ne peut rien fuiter.
  - sortie : `HH:MM:SS <event> <from> <detail>` colorée par alias ; `--json`
    = une ligne MeshFrame par frame, avec `body` systématiquement retiré
    (clé absente, remplacée par `bodyHash`).
  - re-passe `status_req` périodique ? Non : presence frames suffisent.
- **Tests** : `test/cli-reserve.test.ts` (broker temp : reserve dry-run →
  exit 0 ; avec hold 2s pendant qu'un 2e client constate le conflit →
  `findConflict` côté extension seulement… test via client.send reserve puis
  status reservationsOf), `test/cli-watch.test.ts` (spawn watch --json 3 s,
  un client join/leave → lignes presence capturées).
- Effort : ~2 jours.

### Phase 5 — Standalone peer (`attach`) : le mesh sans session Pi (D10) — ✅ implémentée (2026-10-04, 456/456 + smoke)

**Pré-requis (fait en début de phase)** : déplacement
`extension/identity.ts` → `shared/identity-store.ts` (pur move, tests verts).

**`pimesh sessions [--json]`** — inventaire des identités persistées :
- parcourt `<stateDir>/identity-<sessionId>.json` (nouvelle helper
  `listIdentities(stateDir)` dans identity-store : **skip gracieux des JSON
  corrompus/illisibles — jamais de crash**, warning stderr) ; pour chaque
  fichier : alias, rooms, nb réservations, `updatedAt`, et statut live
  (`online/offline` via `status()` du broker — comparaison par alias).
  ⚠ Ambiguïté assumée : un alias live peut être un jumeau (session revenue
  OU adoptant) → afficher alias + sessionId + online **sans trancher
  l'ownership** ; signaler en plus les paths détenus par 2 alias (conflit
  de claims, voir adoption).
- **Scoping documenté** (help + README) : `sessions` ne voit que le
  stateDir courant (`<cwd>/.mesh` ou `MESH_STATE_DIR`) — une session killée
  dans un autre projet n'apparaît pas ; même périmètre que ledger/tail
  (cohérent). « Session introuvable » = vérifier le cwd/MESH_STATE_DIR.
- rotation/hygiène : les fichiers de sessions mortes ne sont JAMAIS
  supprimés par la CLI (c'est le territoire de l'extension/pi) — lecture seule.

**`pimesh attach [alias] [--session <id>] [--room R] [--json] [--no-read]`** :
- **Sans argument** : standalone neuf — alias `standalone-<rand6>` (préfixe
  borné ALIAS_REGEX, constante `STANDALONE_ALIAS_PREFIX` dans config.ts,
  distinction visible face aux `agent-`/`cli-`), rooms par défaut ou `--room`.
- **`attach <alias>`** : claim de l'alias ; si une identité persistée morte
  correspond (offline), propose d'en hériter rooms + réservations (< 24 h,
  règle existante `freshReservations`) — sans confirmation en `--json`
  (mode script), confirmation y/n en interactif. Alias déjà live → exit 1
  `blocked:alias_taken` (D7 : pas de fallback surprise).
- **`attach --session <id>`** : adoption directe du fichier d'identité
  (alias + rooms + réservations via `initialReservations` du hello —
  MeshClientOpts le supporte déjà).
- **Boucle interactive** (défaut, TTY) : `node:readline` (zéro dep) —
  affiche les messages entrants AVEC bodies (destinataire — D10.1),
  colorés par alias ; invite `>` : `<alias> <texte>` = send,
  `/reply <msgId> <texte…>`, `/reply-all <msgId> <texte…>`,
  `/status`, `/reserve <p> <raison>`, `/release`, `/rooms`, `/exit`.
  SIGINT/SIGTERM → release des réservations + close propre (parité Phase 4).
- **Mode script `--json`** : bidirectionnel — stdout = NDJSON events
  (`{"type":"msg","from":…,"msgId":…,"body":…,"ts":…}`,
  `presence`, `activity`, `mailbox-flushed`), stdin = NDJSON commandes
  (`{"cmd":"send","to":…,"message":…,"priority":…}`,
  `{"cmd":"reply","msgId":…,"message":…}`) ; chaque commande reçoit
  un `"ref"` optionnel renvoyé dans l'événement résultat (corrélation
  script). **Validation stdin = table Phase 1** (body 1..32 KiB,
  priority/reason/refs bornés) ; commande inconnue/malformée → event
  `error` AVEC ref, jamais de crash ; backpressure ligne par ligne.
  Dans ce mode : PAS de read frames (pipe = pas une surface
  d'attention — D10.1).
- **Read receipts** (interactif uniquement, défaut on) : `read` émis au
  rendu TTY (MeshClient.sendRead existe déjà) ; `--no-read` pour l'opt-out.
  ⚠ Limites documentées (review 2) : `read` est **online-only silencieux**
  (jamais acké, jamais mailboxé — un read vers un expéditeur offline est
  perdu sans erreur, comportement broker existant) ; un flush de mailbox de
  N messages à l'attach = N reads d'un coup → au-delà d'un seuil
  (`ATTACH_BULK_READ_THRESHOLD`, constante nommée, défaut 20) le mode
  interactif affiche un avertissement et propose `--no-read` ; `script(1)`
  peut simuler un TTY → risque résiduel accepté, opt-out documenté.
- **Mailbox héritée** : les `queued_offline` adressés à l'alias adopté
  sont flushés par le broker au hello — l'opérateur récupère le courrier
  de la session morte. Les drop notices éventuelles restent honnêtes.
- **Cycle de vie des réservations adoptées** (review 2, angle mort) :
  l'adoptant **rafraîchit `since` à now** au moment de l'adoption (un claim
  de 23 h serait « frais » pour la règle 24 h de identity-store mais quasi
  expiré côté conflit 6 h — le rafraîchissement rend l'âge honnête) ;
  **anti-double-claim** : si la session d'origine revient, elle re-déclare
  les mêmes paths sous son alias de repli → `sessions`/`status
  --reservations` signalent les paths détenus par 2 alias ; procédure de
  sortie documentée dans le bandeau d'attach (release côté adoptant avant
  de rendre la main, ou l'originataire relâche ses doublons).
- **Honnêteté affichée** : bandeau d'accueil récapitulant alias, rooms,
  réservations adoptées (avec `since` rafraîchi), mode read on/off, et — si
  adoption — « alias adopted from session <id> ; if that session returns
  it will get a fresh alias » (comportement existant alias_taken →
  fallback).
- **README (même release)** : la définition « Read receipts » et « Honest
  statuses » du README est mise à jour avec l'extension de sémantique
  (`read` = surface destinataire : session OU terminal interactif,
  online-only silencieux) — sinon deux définitions divergent (review 2.6a).
- **Effort : ~2,5-3 jours.**

### Phase 6 — Packaging & distribution (portes bloquantes, review C) — ✅ implémentée (2026-10-04, 456/456 + smoke ; porte pack/npx PASSÉE localement)
- package.json : `"bin": { "pimesh": "dist/src/cli/mesh.js" }`, `"files"`
  déjà corrects (dist inclus), shebang en tête de `mesh.ts` (le compilateur
  le préserve ; npm met le chmod +x à l'install).
- `scripts/sync-version.mjs` (phase 0) branché sur `build` + **test
  MESH_VERSION == package.json version** dans la suite.
- **Porte bloquante #1** : `npm pack` → install de l'archive dans un dir
  temp → `npx pimesh doctor` et `pimesh --help` fonctionnent. Si KO, le doc
  npx est un mensonge → pas de release.
- **Porte bloquante #2** : vérifier si `pi install npm:pi-mesh-extension`
  expose le bin quelque part ; sinon documenter uniquement `npx`/global.
- CI : matrice **win32** obligatoire (V8) exécutant le smoke CLI ; job
  `npx` post-pack.
- README : section CLI réécrite (tableau des commandes, **exit codes**,
  remote, exemples multi-machine avec `MESH_BROKER_URL`), mention `npx
  pi-mesh-extension` fallback quand installé via `pi install`, correction du
  contrat L351 (B1), **et mise à jour des définitions « Honest statuses » /
  « Read receipts »** avec l'extension de sémantique D10.1 (read = surface
  destinataire session OU terminal interactif, online-only silencieux).
- CONTRIBUTING : ajout d'un bloc "CLI rules" (honnêteté, zéro dep, pas de
  read frames, pas de bodies affichés — D8, bornes nommées, token jamais en
  argv).
- Effort : ~0,5 jour.

### Phase 7 — Confort (optionnel, post-v1) — ⏸ arbitré : `shell` RETIRÉ du backlog (attach couvre le besoin : envoi/réception/attente multi-missions en process persistant) ; restent en backlog optionnel : completion bash/zsh, `pimesh report` (wrapper de scripts/session-report.mjs)
- `pimesh shell` : mini-REPL multi-missions sur UN client persistant (send/
  wait/status/stale en interne, plus de process par commande) — utile aux
  orchestrateurs humains ; alias stable pendant la session.
  ⚠ Recouvrement avec `attach` à arbitrer : si attach couvre déjà le besoin
  (il envoie, reçoit, attend), `shell` peut être retiré du backlog —
  décision à la fin de la Phase 5 (review).
- Complétion bash/zsh générée (`pimesh completion bash`) — génération pure
  texte, zéro dep.
- `pimesh report` : wrapper de `scripts/session-report.mjs` (déjà standalone)
  intégré au bin avec `--json` (réutilisation directe, le script existe).
- `--room` globaux via env `MESH_ROOMS` (déjà géré par loadConfig).

## 2.5 Sémantiques délicates — décisions argumentées

1. **Reservations** (B3) : le modèle "réservation = connexion vivante" est
   un invariant du système (re-déclarées au hello, TTL 6 h). La CLI ne doit
   PAS introduire un 2e modèle (fichier de claims) — ce serait une fuite
   d'architecture et un mensonge potentiel. D'où : dry-run par défaut +
   `--hold` explicite qui maintient le process. Honnête et minimal.
2. **Read receipts** : la CLI n'émet pas de `read` (elle n'est pas une
   session). Conséquence : `send --await` vers un agent lit la réponse via
   le canal `reply` (mécanisme existant) — aucun contournement nécessaire.
3. **wait cross-process** : `waitAll` est mémoire client. On n'introduit pas
   de file durable de missions CLI (V2 : persister des états de missions =
   nouveaux fichiers à risque). `send --await` (synchrone) couvre le script
   simple ; `attach` (phase 5) et `shell` (phase 7) couvrent l'usage
   interactif multi-missions.
4. **Aliases éphémères vs --alias** : garder `cli-<rand6>` par défaut évite
   les usurpations et les `alias_taken` en boucle ; `--alias` pour les
   workflows nommés. Le broker fait autorité sur l'unicité ; avec `--alias`
   explicite le fallback client est **désactivé** (D7) — collision = exit 1,
   jamais d'identité surprise.
5. **Couleurs** : duplication légère ou déplacement `shared/colors.ts` —
   jamais d'import extension→cli inversé (V4 : cli est au-dessus de client,
   jamais sous extension). Préférence : déplacement.
6. **queued_offline n'est pas un succès** (review 18) : exit 4 par défaut
   (partiel honnête — rien n'est livré), `--require-online` pour le durcir
   en exit 1. Sans ça, un orchestrateur confond « mis en file » et « livré ».

## 2.6 Matrice de tests (résumé)

| Test | Contenu |
|---|---|
| `cli-args.test.ts` | parseur pur : flags, =, répétés, --, erreurs → exit 2 |
| `cli-help.test.ts` | --help par commande, exit 0 |
| `cli-send.test.ts` | 2 process + broker temp : delivered/reply/blocked/expired + exit codes |
| `cli-rooms.test.ts` | UN micro-test wiring (join dispatché → exit ≠ 2, 5 lignes) — debug-only mais le contrat B1 doit rester testé |
| `cli-reserve.test.ts` | dry-run + hold + release + conflit visible par un pair |
| `cli-tail.test.ts` | fixture ledger + append en cours de -f |
| `cli-doctor.test.ts` | reachable/lock STALE/version drift |
| `cli-watch.test.ts` | capture presence en --json 3 s |
| `cli-sessions.test.ts` | fixtures identity-<id>.json + statut live online/offline ; fichiers jamais modifiés |
| `cli-attach.test.ts` | attach neuf → send reçu AVEC body + read émis sur TTY simulé ; attach --json : events stdout + cmd stdin (send/reply) + AUCUN read + **stdin corrompu → event error avec ref, pas de crash (×2)** ; adoption : alias mort adopté, **`since` rafraîchi**, résa < 24h re-déclarées, mailbox flush visible ; alias live → exit 1 alias_taken |
| smoke CLI (scripts) | E2E bash/zsh : doctor → send --await → tail → broker stop ; + npm pack → npx gate (phase 5) |

## 2.7 Explicitement rejeté (respect de la vision)

- ❌ Persistance de bodies/history côté CLI (V2).
- ❌ Émission de read receipts par les commandes one-shot (V1) — exception :
  `attach` interactif TTY (D10.1), jamais en `--json`/pipe.
- ❌ Dépendances runtime (commander, chalk, blessed…) (V3).
- ❌ Superviseur de broker / foreground long-running autre que le broker
  détaché existant (V7).
- ❌ Réimplémentation du protocole ou accès direct aux internals broker (V4).
- ❌ `mesh` comme nom de bin (collision npm).
- ❌ File durable de missions cross-process (V2/V10).
- ❌ `config set` / éditeurs de policy en CLI v1 (un $EDITOR suffit).
- ❌ Flag `--token` (exposition `ps aux`) — token uniquement env/config (D9).
- ❌ `reserve --hold forever` (malhonnête : le TTL 6 h expirerait le claim).
- ❌ `broker stop` sans garde (DoS des sessions Pi locales co-connectées).

## 2.8 Risques & mitigations

| Risque | Mitigation |
|---|---|
| bin `pimesh` pris entre-temps sur npm | vérifier au jour de publication + fallback `pi-mesh-cli` (affirmation « libre » re-vérifiée à la release, review 6) |
| pi install n'expose pas le bin | **porte bloquante phase 5** : test pack → npx ; sinon doc npx uniquement |
| Attente --await longue (30 min défaut client) vs script CLI | défaut CLI explicite court (30 s) + `--timeout` ; constantes séparées |
| `tail -f` sur rotation (rename) | watcher sur le répertoire, pas le fichier |
| SIGINT pendant hold/reserve → claim zombie | handlers SIGINT/SIGTERM → close() systématique ; tests dédiés (SIGTERM win32 émulé) |
| Windows : tests spawn + pipes nommés | matrice CI win32 obligatoire (porte bloquante #3) |
| Volume de sortie `watch --json` | buffer ligne par ligne, flush stdout (pas de pipe blocking) |
| Body reçu par un watcher (send ciblé) | rédaction absolue au point d'impression, texte ET json (D8) — watch = monitoring, hash only |
| Adoption : la session d'origine revient | comportement existant alias_taken → fallback aléatoire + notification ; bandeau attach le documente (D10.1) |
| Read émis à tort (pipe déguisé en TTY) | détection isTTY + --no-read ; --json n'émet JAMAIS de read (D10.1) |
| REPL attach : Ctrl-C pendant une réservation | mêmes handlers SIGINT/SIGTERM que Phase 4 → release + close |
| Double-claim au retour de la session d'origine | `since` rafraîchi à l'adoption + détection paths × 2 alias dans sessions/status + procédure de sortie documentée (bandeau) |
| Session killée « introuvable » | scoping sessions = stateDir courant (cwd/MESH_STATE_DIR) documenté dans help + README |

## 2.9 Séquencement & effort

| Phase | Contenu | Effort | Livrable |
|---|---|---|---|
| 0 | Fixes B1/B6/B11/B12 + usage + README L351 | 0,5 j | bugs fermés, tests verts |
| 1 | Socle args/out/codes/ctx + dispatcher + help + table validation | 1,5 j | refactor complet |
| 2 | send/reply/wait/ping/rooms parité | 2 j | parité tools |
| 3 | ledger/tail -f/status --reservations/doctor/config | 1,5 j | observabilité |
| 4 | reserve honnête + watch | 2 j | sémantique résa |
| 5 | **standalone peer** : attach + sessions + adoption (+ move identity-store + strictAlias client) | 2,5-3 j | mesh sans session Pi |
| 6 | bin/packaging/CI/docs (portes bloquantes win32/npx/version + README read-def) | 0,5 j | v0.8.0 publiée |
| 7 (option) | shell (à arbitrer vs attach), completion, report | +2 j | v0.9 |

Total cœur : **~10-11 jours** pour une CLI complète, honnête, zéro dépendance,
publiée dans le package existant sans nouveau nom npm — avec le mode
standalone (mesh utilisable par un humain/script sans session Pi).

---

# ANNEXE 1 — Standalone peer : réponses aux questions ouvertes

1. **« Créer un mesh en mode vide »** = `pimesh broker start` (existant,
   auto-spawn d'ailleurs) + `pimesh attach` — le broker n'a pas de « mode » :
   il est déjà un réseau vide prêt à recevoir des pairs ; le standalone est
   simplement le premier pair sans session derrière.
2. **Remote** : attach honore `MESH_BROKER_URL`/`MESH_BROKER_TOKEN`/config
   comme tout le reste — un opérateur peut attaché au broker d'une autre
   machine (V9) et lire/envoyer depuis son terminal.
3. **Réservations du standalone** : tenues tant que le process vit (TTL 6 h,
   re-reserve pour renouveler — parité extension) ; sortie propre = release.
4. **Pas de nouveau fichier persisté** : attach ne crée AUCUN fichier
   (l'identité vit le temps du process) ; il ne fait que LIRE les
   `identity-<sessionId>.json` existants (V2 intact).

---

# ANNEXE 2 — Review @agent-412bf0 (2026-10-04, mission m_mutfiwar_f3bb3773)

**Verdict : OK avec réserves.** Invariants V1..V11 jugés fidèles au code
(vérifiés fichier par fichier) ; bugs B1..B10 tous confirmés ; design
D1..D6 validé sauf réserves — intégrées ci-dessus :

1. **R17 (majeure)** — « watch zéro bodies par construction » survendu :
  `observer_readonly` bloque l'envoi, pas la réception → rédaction absolue
  au point d'impression (D8 + §Phase 4 + risques).
2. **R18** — `queued_offline` en exit 0 malhonnête → exit 4 + `--require-online`
  (D5 + §2.5.6).
3. **R15** — `--alias` explicite doit désactiver le fallback `alias_taken` (D7).
4. **R12** — V5 violé aujourd'hui par la CLI (constantes hardcodées) → B11,
  corrigé Phase 0.
5. **R16** — `send --json` ne doit pas renvoyer le body (D8).
6. **R20** — spec sécurité minimale absente → D9 (token jamais argv, garde
  `broker stop`, hold plafonné, rappel rate caps).
7. **R21** — table de validation/bornes manquante → ajoutée Phase 1.
8. **R22** — CI/packaging : win32 + npx pack + version-sync = portes
  bloquantes Phase 5 ; README L351 à corriger avec B1.
9. **R23** — `join/leave/rename` one-shot quasi inutiles → debug-only,
  sans tests dédiés ; `stale` fusionné dans `status --reservations` ; ping
  gardé comme sucre assumé ; Phase 6 reste optionnelle.
10. **R24** — voie scriptée par défaut = `send --await` synchrone (les
  exemples README le montreront) ; `--launch`+`wait` documentés same-process.
11. **B12 (nouveau, trouvé en review)** — `expired` → exit 0 aujourd'hui :
  ajouté aux bugs, corrigé par D5 Phase 0/1.

## Passe 2 (2026-10-04, mission m_mutfu57i_f1edfc17 — après ajout D10)

**Verdict : OK avec réserves.** Intégrations passe 1 vérifiées fidèles ;
D10/Phase 5 confirmés **faisables sans changement de protocole**
(MeshClient : hello initialReservations L766-772, onFrame, sendRead public,
mailbox flush post-welcome, alias_taken retry-then-fallback) ; move
identity.ts→shared confirmé sans risque V4 (imports fs/path + protocol
seuls). Réserves — toutes intégrées :

1. **Contradiction #1 levée** : §2.0.7 et §2.7 amendés avec l'exception
   `attach` TTY (read) — les clauses « jamais de read » valent pour les
   one-shot.
2. **Contradiction #2 levée** : refs « phase 6 »→7 corrigées (§2.2 wait,
   §2.5.3) ; D4 harmonisé `status`/`stale` ; cli-rooms = UN micro-test
   wiring conservé.
3. **Read-sur-TTY jugé compatible V1** (extension honnête, pas un
   gonflage) sous durcissements intégrés : README mis à jour dans la même
   release ; read online-only silencieux documenté ; seuil
   ATTACH_BULK_READ_THRESHOLD sur les flushes de mailbox ; risque
   résiduel script(1) → --no-read.
4. **Cycle de vie des claims adoptés spécifié** : `since` rafraîchi à
   l'adoption, détection double-claim (paths × 2 alias) dans
   sessions/status, procédure de sortie au bandeau.
5. **Multi-stateDir documenté** : scoping sessions/ledger/tail = stateDir
   courant (cwd/MESH_STATE_DIR), « introuvable » → vérifier le cwd.
6. **strictAlias = nouveau code client** (MeshClientOpts), pas un câblage —
   spécifié Phase 2 + reconnect attach strict (échec bruyant).
7. **stdin --json borné** : validation = table Phase 1, commande inconnue →
   event error avec ref (jamais de crash), backpressure ligne à ligne,
   tests stdin corrompu ×2.
8. **Effort Phase 5 réévalué** : 2,5-3 j ; total ~10-11 j.
