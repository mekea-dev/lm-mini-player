# Servidor de salas (opcional)

As **salas** deixam várias pessoas assistirem o mesmo vídeo ao mesmo tempo: quem põe, pausa, pula, muda a velocidade ou troca de vídeo, muda para todos. Ninguém transmite tela nem áudio: **cada pessoa toca o seu próprio vídeo do YouTube** e o programa só mantém todo mundo no mesmo ponto.

Para isso é preciso um pequeno servidor que guarda o *estado* de cada sala (qual vídeo, em que segundo, tocando ou pausado, velocidade). Este guia monta um **grátis** no Cloudflare (Workers + banco D1), pelo painel do site, sem instalar nada. Enquanto nenhum servidor estiver configurado, o botão de sala não aparece no programa.

> **Quem só usa o programa não precisa fazer nada daqui:** o programa pronto (baixado em *Releases*) já vem ligado ao servidor do projeto original, configurado em [`web/config.js`](../web/config.js). Este guia é para quem faz um fork ou quer ter o próprio servidor.

## O que o servidor guarda

Por sala: o código, o vídeo (ID do YouTube), a posição, se está tocando, a velocidade e uma lista de identificadores aleatórios de quem está na sala (um por janela aberta, gerado na hora, não fica guardado no computador e não tem nome, e-mail nem nada pessoal). Salas sem uso por 24 horas são apagadas. Como em qualquer servidor, o Cloudflare enxerga o endereço IP de quem se conecta.

## Montar no Cloudflare (uns 10 minutos)

1. Crie uma conta grátis em <https://dash.cloudflare.com/sign-up> (se já tem, entre).
2. **Banco de dados.** No menu, *Storage & Databases* → **D1 SQL Database** → **Create database**. Nome: `lm-salas`. Abra o banco, vá na aba **Console**, cole o conteúdo do arquivo [`schema.sql`](schema.sql) e clique em **Execute**.
3. **Servidor.** No menu, *Compute (Workers)* → **Create** → **Create Worker**. Nome: `lm-salas` → **Deploy**. Depois clique em **Edit code**, apague tudo o que estiver lá, cole o conteúdo de [`worker.js`](worker.js) e clique em **Deploy**.
4. **Ligar o banco ao servidor.** No Worker `lm-salas`: **Settings** → **Bindings** → **Add** → **D1 database**. O nome da variável tem de ser exatamente **`DB`**; escolha o banco `lm-salas` → **Deploy**.
5. Copie o endereço do Worker (algo como `https://lm-salas.SEU-USUARIO.workers.dev`). Para conferir, abra no navegador `https://lm-salas.SEU-USUARIO.workers.dev/api/room/ABCDEFGH`: deve aparecer `{"now":…,"error":"room_not_found"}` (a sala não existe, e está tudo certo).
6. No projeto, edite [`web/config.js`](../web/config.js) e coloque o endereço:

   ```js
   window.LM_CONFIG = { relay: 'https://lm-salas.SEU-USUARIO.workers.dev' };
   ```

   Compile de novo (`build.ps1`) ou publique uma versão nova. O botão **Sala** (ícone de pessoas) passa a aparecer na barra e na tela inicial.

### Limites do plano grátis

O plano grátis do Cloudflare dá 100 mil pedidos por dia ao Worker. Quem está numa sala faz **1 pedido por segundo** (cerca de 3.600 por hora por pessoa); fora de uma sala, nenhum. Para um grupo de amigos sobra bastante. Se um dia o limite acabar, o programa mostra "Reconectando…" e volta sozinho quando o dia virar.

## Como as pessoas usam

- **Criar:** botão **Sala** → **Criar sala**. O programa mostra um código de 8 letras e números (sem 0, 1, I e O, que se confundem). Passe o código para os amigos.
- **Entrar:** botão **Sala** → digite o código → **Entrar**. Se a sala estiver em outro vídeo, o programa carrega o dela.
- Dentro da sala, pausar, tocar, pular na barra, mudar a velocidade ou colar outro link vale para todos. Pequenos atrasos (rede, carregamento, anúncio) são corrigidos sozinhos.
- **Sair da sala** volta ao normal, e a velocidade preferida de cada um é restaurada.
- A velocidade dentro da sala é **da sala**: não altera a velocidade que você prefere fora dela.

## Como funciona (resumo)

O estado da sala leva a **hora do servidor**. Cada programa pergunta o estado a cada segundo (a cada 2 s se a sala está parada há muito tempo), calcula a diferença entre o relógio do servidor e o do computador, e põe o vídeo na posição certa mesmo que a resposta demore. Se o vídeo de alguém ficar mais de 1,5 s fora do lugar, ele é trazido de volta sem avisar a sala (para não gerar eco).

API (ver [`worker.js`](worker.js)):

```
GET  /api/room/<CODIGO>?since=<v>&id=<id>      -> { now, v, members, state? }   (state só se mudou)
POST /api/room/<CODIGO>  { id, op: "create" }                                   -> cria a sala
POST /api/room/<CODIGO>  { id, op: "set", state: { vid, list, pos, playing, rate } }
```

## Testar sem Cloudflare

Os testes ficam em [`../tests`](../tests) e só precisam de Python 3 (biblioteca padrão):

- **Servidor falso na memória**, com o mesmo protocolo: `python tests/mock-relay.py 8801`. Para o programa usá-lo sem mexer em `web/config.js`, abra o console da página e rode `localStorage['lmmp.relay'] = 'http://127.0.0.1:8801'`.
- **O código real do `worker.js` contra um SQLite de verdade:** `python tests/d1-shim.py 8802` sobe um "D1 falso" (SQLite em memória com a mesma forma de resposta do D1). Com `python -m http.server 8000` na pasta do projeto, abra <http://localhost:8000/tests/worker-test.html>: a página roda o Worker contra ele e mostra **OK 35/35** (rotas, validação, limites, gravações simultâneas, presença, limpeza de salas velhas). Reinicie o `d1-shim.py` antes de repetir.
