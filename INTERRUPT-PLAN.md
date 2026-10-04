# Plan — `interrupt` : débloquer un agent coincé dans une commande

> Besoin utilisateur : un agent peut rester coincé DANS une commande bash
> (sleep long, commande interactive, process récalcitrant). Il faut un moyen
> « à utiliser avec précaution » qui (1) **arrête le process où l'agent est
> coincé** et (2) **livre le message en priorité sur le flux de l'agent**.
>
> Statut : ✅ IMPLÉMENTÉ (2026-10-04, 466/466 tests + smoke 4/4). Review par
> agent pair : voir Annexe.

---

## 1. Analyse de l'existant (v0.7.1, vérifiée dans le code)

### 1.1 Ce qui existe déjà et marche

| Élément | État | Preuve |
|---|---|---|
| `priority: force` (abort du tour + steer à la stabilisation) | ✅ implémenté | inbound.ts `injectInbound` : `ctx.abort()` si busy, puis `deliverWhenIdle` |
| force **contourne le batcher** (jamais retenu pendant un appel d'outil long) | ✅ | batcher.ts `bypassesBatch` |
| pi `abort()` tue l'**arbre de process** de l'outil en cours | ✅ côté pi | pi `core/tools/bash.js` : listener abort → `killProcessTree(pid)` → SIGKILL du groupe (Unix) — c'est exactement ce que fait ESC pour un humain |
| API extension : `ctx.abort()`, `ctx.isIdle()`, `ctx.signal` | ✅ exposées | pi `core/extensions/types.d.ts` L230-240 |
| Gardes force : `reason` obligatoire (hachée), limite de débit 1/min, `forceAllowedFrom` | ✅ | broker policy.ts + envelope |

### 1.2 Les trous réels (pourquoi « ça ne passait pas »)

| # | Trou | Impact | Preuve |
|---|---|---|---|
| T1 | **force est REFUSÉ par défaut** : `forceAllowedFrom: []` → toute commande force sort `policy_denied` tant que l'opérateur n'a pas configuré `.mesh/policy.json` | L'outil de déblocage existe mais est inutilisable boîte-ouverte ; l'incident vécu (« agent bloqué, rien à faire ») | policy.ts `DEFAULT_POLICY` + `evaluatePolicy` (`!includes(from)` → deny) |
| T2 | **Plafond de stabilisation court** : `FORCE_IDLE_MAX_MS = 3 000` — si le tour n'est pas stabilisé en 3 s, fallback steer qui **attend la fin du tour** | Un abort avalé/lent = message à nouveau en attente du tour bloqué | inbound.ts L177 |
| T3 | **Abort à usage unique** : un seul `ctx.abort()` ; s'il est avalé (hook, course de fin de tour), aucune tentative supplémentaire | Le process n'est pas tué, le message ne passe pas | injectInbound (un seul appel) |
| T4 | **Dénégation de réalité silencieuse** : l'accusé de réception `interruptStatus: force_accepted` reflète la POLITIQUE du broker, pas la RÉALITÉ côté destinataire (abort réellement délivré ? tour réellement stabilisé ?) | L'émetteur croit que le blocage est résolu — rupture de la promesse V1 (statuts honnêtes) | broker ack vs aucun accusé de réception destinataire |
| T5 | **Invisible** : rien n'indique au destinataire humain/agent QUE son tour a été interrompu par un pair ni pourquoi | Confusion, perte de confiance ; la `reason` hachée n'est jamais montrée au destinataire | aucun chemin de notification |

### 1.3 Ce qui est impossible (à documenter, pas à tenter)

- **Tuer un process extérieur à pi** : l'extension ne voit que les process de ses propres outils ; le mécanisme d'interruption passe donc TOUJOURS par `pi.abort()` (qui SIGKILL l'arbre de l'outil). « Arrêter le process où l'agent est coincé » = ce chemin, pas un `kill` direct.
- **Interruption pendant une restriction de débit fournisseur (⛔)** : si le destinataire est en attente 429 (hold), l'interruption est maintenu comme le reste — l'abort ne soigne pas un fournisseur mort (documenté, pas corrigé).

---

## 2. Décision de conception (ADR)

### D1 — Un drapeau `interrupt: true` sur l'émission, PAS une 4e priorité
- `PRIORITIES = [normal, urgent, force]` reste un ensemble fermé (protocole stable, files d'attente de limitation de débit, politique). `interrupt` est un **modificateur orthogonal** : `mesh_send { priority: "force", reason, interrupt: true }`.
- Validation stricte : `interrupt: true` **exige** `priority: force` + `reason` (sinon `invalid_frame` au client ET au broker — échec rapide des deux côtés). La précaution est dans la friction : force + raison + drapeau explicite.
- Refus auto-escalade implicite : `interrupt` avec priorité `normal` = erreur d'utilisation (éducation), pas une escalade magique.

### D2 — Sémantique côté destinataire : « abort répéteur avec plafond, puis injection prioritaire »
1. `ctx.abort()` immédiat (comme aujourd'hui) — TOUJOURS précédé d'un check `!isIdle()` (fenêtre de course minuscule mais réelle ; l'injection n'a lieu qu'après settle).
2. Sondage `isIdle` avec plafond étendu `INTERRUPT_IDLE_MAX_MS = 10 000` (un SIGKILL d'arbre est rapide ; c'est la stabilisation de l'hôte qui peut traîner).
3. **Nouvel essai d'abort** si toujours occupé après `INTERRUPT_REABORT_AFTER_MS = 1 500`, max `INTERRUPT_REABORT_MAX = 2` tentatives supplémentaires (un abort peut être avalé par une course de fin de tour).
4. À la stabilisation (ou au plafond) : injection `steer` + `triggerTurn` — le message passe AVANT tout autre travail en file d'attente.
5. Au plafond échu sans stabilisation : injection quand même (steer, comme aujourd'hui) MAIS accusé de réception honnête « still_busy » (voir D3).

### D3 — Receipt honnête (ferme T4/T5) : une RÉPONSE corrélée, opt-out, jamais en cascade
- Le destinataire, après traitement, renvoie une **réponse** corrélée par `replyTo = m_<id>` : priorité **NORMALE**, jamais force/interrupt → compose avec `--await` (verdict inline) et interdit toute cascade (un receipt ne peut pas interrompre quiconque).
- Marqueur `receipt: true` sur la trame : rendu **INFO ONLY + followUp sans triggerTurn** chez un émetteur non-attendant — sinon une réponse orpheline OUVRIRAIT un tour chez lui (les orphelines SONT injectées ; l'INFO ONLY n'existe nativement que pour les reply-à-reply). La validation tolère les champs inconnus (pass-through) → forward-compat, fallback documenté si rejeté.
- Wording dérivé du flag `aborted` existant d'injectInbound :
  - aborté → `⚠ m_<id> interrupted: turn aborted, message delivered`
  - déjà inactif → `⚠ m_<id> interrupt: already idle, message delivered`
  - plafond échu → `⚠ m_<id> interrupt: still busy after N aborts, message queued`
  JAMAIS « process killed » (non observable depuis l'extension).
- Opt-out : `interruptReceipts: false` (config.json / `MESH_INTERRUPT_RECEIPTS=0`).
- Notification locale au destinataire : `ctx.ui.notify("⚠ turn interrupted by force from @x")` (la reason n'existe que hachée — le corps du message arrive derrière et l'explique).
- **Compteurs `mesh_status` (« last force ») : MÉMOIRE uniquement, jamais dans le ledger.**

### D4 — Politique inchangée dans sa forme, outillée dans la pratique (ferme T1 sans ouvrir la porte)
- `forceAllowedFrom` reste une liste d'approbation (option explicite) — OUVRIR force à `*` par défaut trahirait la prudence exigée ; l'auto-allow same-stateDir n'ajouterait aucune sécurité réelle (alias auto-déclarés au hello, spoofables en local).
- Ce qui change : **documentation de déblocage première classe** — section README « Débloquer un agent coincé » (`forceAllowedFrom: ["lead"]` + exemple complet), indication dans `mesh doctor` (« force : refusé par défaut — voir la section de déblocage »), compétence mesh-coordination mise à jour.
- Par défaut, l'erreur d'un émetteur non approuvé reste `policy_denied` MAIS le message d'erreur côté client mentionne la cause (« force nécessite forceAllowedFrom dans .mesh/policy.json du destinataire »).

### D5 — CLI parité immédiate
- `pimesh send <alias> <texte> --interrupt` : auto-exige `--priority force --reason R` (erreur d'utilisation sinon), même contrat de code de sortie (livré 0 / bloqué 1).

### D6 — Downgrade × interrupt : le broker STRIP le flag (verrou critique)
- Avec `forceDowngrade: true`, un force non approuvé devient **urgent** au routage — une trame `urgent + interrupt` qui atteindrait le destinataire serait soit droppée après ack (delivered menteur), soit honorée sur urgent (bypass d'escalade). Ni l'un ni l'autre.
- Règle : **le downgrade retire `interrupt` de la trame routée** (l'ack `force_downgraded` existant dit déjà la vérité au sender). Test dédié obligatoire.

---

### Phase 0 — Reproduction & audit (0,5 j)
- Repro scripté : session headless pi (mode SDK) lançant `sleep 60`, envoi force → mesurer (a) le délai de stabilisation après l'abort, (b) si l'arbre meurt (vérifier le pid enfant), (c) le comportement rpc/json (abort disponible ?).
- **win32 inclus** : killProcessTree n'y est PAS un SIGKILL de groupe — mesurer le comportement (la CI windows existe déjà).
- Vérifier les droits d'accusé de réception d'interruption sur les modes non-TUI.
- **Critère** : chiffres mesurés qui alimentent les constantes de la Phase 4 (10 s/1,5 s/2 justifiés ou ajustés).

### Phase 1 — Protocole (0,5 j)
- `MeshFrame.interrupt?: boolean` ; `validateFrame` : interrupt⇒(force+reason) sinon erreur ; `buildFrame` transmet.
- Tests protocole : trame valide/invalides (interrupt+normal, interrupt sans raison).

### Phase 2 — Client & surfaces d'émission (0,5 j)
- `SendOpts.interrupt` → MeshClient.send (garde locale identique), outil `mesh_send` (paramètre + description « casse la commande bloquée du destinataire — précaution »), CLI `--interrupt` (D5).
- Tests client : garde, trame émise.

### Phase 3 — Broker (0,5 j)
- Validation comme le client ; politique/limitation de débit = celles de force (aucun nouveau bucket) ; `interruptStatus` inchangé.
- Tests broker : refus interruption-normale, force non approuvé → refus, approuvé → livraison + trame intacte.

### Phase 4 — Extension destinataire : le cœur (1,5 j)
- `injectInbound` : branche interrupt (D2) — constantes nommées dans config.ts, essai avec plafond, files d'attente/rappels/réponses inchangés.
- Accusé de réception (D3) via réponse automatique + option de retrait ; notification locale ; compteur honnête dans `mesh_status` (`dernier force : interrompu à HH:MM`).
-Interaction auditée :Deferred Inbox (l'interruption bypasse-t-elle ? NON — l'inbox différée ne concerne que les diffusions ; une trame force va direct), attente fournisseur (documenté §1.3), watchdog (aucun).
- Tests : repro sleep (E2E extension : livré après abort <2 s), abort avalé simulé (1er abort sans effet → essai délivre), plafond échu → accusé de réception « still_busy », option de retrait de l'accusé de réception.

### Phase 5 — Documentation & politique (0,5 j)
- README : « Débloquer un agent coincé » (politique minimale, exemple force+interrupt, sémantique d'accusé de réception, limites §1.3) ; indication dans doctor ; compétence (protocole d'escalade : normal → urgent → force+interrupt, « l'interruption = dernier recours, toujours avec une raison »).
- CONTRIBUTING : règle « l'interruption ne prétend jamais à un process tué ».

### Phase 6 — Contrôle final (0,5 j)
- Matrice : protocole/client/broker/extension/CLI/Documentation + CI windows.
- Estimation total : **~4,5 j**.

---

## 4. Risques & rejets explicites

| Risque | Traitement |
|---|---|
| Abort avalé par l'hôte (course) | essai avec plafond (D2) + accusé de réception « still_busy » honnête |
| Double injection (stabilisation vue deux fois) | garde `sent` existante de deliverWhenIdle, réutilisée |
| Pollution par l'accusé de réception (réponse auto chez un émetteur occupé) | marqueur INFO ONLY (mécanisme existant reply-à-reply) + opt-out |
| Interruption utilisée comme marteau (spam) | limitation de débit 1/min (force) + politique d'approbation + raison obligatoire + doc « dernier recours » |
| Tuer un process nécessaire (perte de travail) | assumé et documenté : c'est le BUT (sortir de l'impasse) ; la raison hachée + le corps du message expliquent ; personne ne peut prétendre l'ignorer (notification locale) |

**Rejetés** : 4e priorité « break » (D1) ; force ouvert à `*` par défaut (D4) ; kill direct de pid externe (impossible, §1.3) ; interruption bypassant l'attente fournisseur (soignerait rien, casserait la protection contre les tours morts).

---

## Annexe — Review agent-412bf0 (2026-10-04) : OK avec réserves → tout intégré

- **Verdict initial** : design sain, analyse §1 fidèle au code (T1-T5 vérifiés ligne à ligne ; bémol : pi core hors repo → bash.js/killProcessTree invérifiables ici, d'où la Phase 0 en tête).
- **R1 (substantielle, intégrée → D6)** : trou `forceDowngrade × interrupt` non couvert — le broker doit STRIP `interrupt` au downgrade (sinon delivered menteur ou bypass d'escalade). Test dédié ajouté Phase 4.
- **R2 (substantielle, intégrée → D3 respécifiée)** : les replies orphelines SONT injectées (l'INFO ONLY natif ne couvre que les reply-à-reply) → receipt = reply corrélée `replyTo`, priorité NORMALE (compose avec --await, cascade impossible), marqueur `receipt: true` → INFO ONLY + followUp sans trigger, wording dérivé du flag `aborted` existant.
- **R3 (intégrée → D2)** : check `!isIdle()` impératif avant CHAQUE abort ; reminds exclus du re-abort (pas de tempête) ; re-abort nécessaire, pas redondant.
- **R4 (intégrée → D4)** : auto-allow same-stateDir rejeté (alias spoofables au hello) ; opt-in policy + doc première classe confirmés.
- **R5 (intégrée → Phases 0/4)** : mesures win32 explicites (killProcessTree ≠ Unix) ; tests downgrade×interrupt, 429-hold, receipt-sans-cascade ; compteurs mesh_status MÉMOIRE uniquement.
- **GO Phase 1** après intégration (fait).
- **Review d'implémentation (2026-10-04)** : OK avec réserves → tout intégré.
  (1) Correction requise appliquée : contrat « Never throws » tenu sur le
  chemin ASYNC (safeAbort/safeDeliver enrobent les aborts et livraisons
  dans les timers — un host en teardown dégrade au tick suivant au lieu de
  crasher pi). (2) ÉCART receipt-never-settles APPROUVÉ par le reviewer
  (« meilleur que ma suggestion ») : un receipt ne clôt jamais une mission
  --await, la vraie réponse reste attendue. (3) D6, doctor, wording,
  compteurs mémoire-only, docs/skill : approuvés sans réserve. Suite
  finale : 466/466 + smoke 4/4.
