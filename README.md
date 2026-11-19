# Shardfield

Vektorgrafiskt rymdskjutarspel i webbläsaren för 2–6 spelare. Alla som öppnar samma rumslänk (`/#rumsnamn`) hamnar i samma match. Stenar spricker i mindre, snabbare skärvor, rundor startar om automatiskt och en topplista sparar de bästa resultaten.

## Struktur
- `public/sim.js` – deterministisk spellogik som delas av server och klient
- `public/index.html` – klienten: rendering, styrning, ljud, nätverk, topplista
- `server.js` – Node utan npm-beroenden: statiska filer, WebSocket `/ws?room=&name=` med HTTP long-poll som reserv (`/api/*`), simulering i 60 Hz, snapshots i 30 Hz och topplista i `DATA_DIR/leaderboard.json`
- `k8s/`, `kustomization.example.yaml` – driftsättning i Kubernetes
- `test/` – röktester lokalt och mot en driftsatt server

## Köra lokalt
```bash
npm start          # http://localhost:8080
npm test           # två WS-spelare + en HTTP-spelare, topplista och persistens
```
Kräver Node 22 eller senare.

## Driftsätta i Kubernetes
Koden läggs i en ConfigMap och körs på en vanlig `node:22-alpine`-image, så det behövs ingen egen image eller något register. ConfigMap-namnet får en innehållshash, så varje kodändring rullar ut en ny pod. Topplistan ligger på en egen volym (PVC).

```bash
cp kustomization.example.yaml kustomization.yaml   # fyll i namespace, värdnamn och ev. storage class
kubectl --context <din-kontext> apply -k .
node test/remote.js https://<ditt-värdnamn>
```
Routingen sker med en Traefik `IngressRoute`. Matcherna ligger i minnet, så kör en replika.
