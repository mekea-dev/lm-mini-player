# Histórico de versões

## v1.4.0 - 2026-11-12

- **Conversa por voz nas salas.** Dentro de uma sala, o botão de **microfone** (na barra de cima e no painel da sala) liga a voz, como num Discord: todo mundo ouve todo mundo enquanto assiste junto. O áudio vai **direto entre os computadores** (WebRTC), sem passar pelo servidor. Tem **dois volumes separados**, o do vídeo e o das vozes, **volume e silenciar por pessoa** (só para você), o silenciar do seu próprio microfone, um contorno verde em quem está falando e o ícone vermelho em quem está mudo. Dá para entrar na voz só para ouvir, sem microfone. **Use fones de ouvido** para não gerar eco. Até 8 pessoas por sala. Em redes muito restritas (algumas de empresas e faculdades) a voz pode não conectar; o vídeo continua sincronizado.
- **Sincronia em tempo real.** O servidor das salas agora mantém uma conexão aberta com cada pessoa (WebSocket com Durable Objects, no Cloudflare), em vez de ser consultado a cada segundo. Pausa, play, pulo, velocidade e troca de vídeo chegam aos outros em menos de meio segundo (antes passava de 1 segundo), e o relógio de cada computador é medido de novo de tempos em tempos para manter o ponto do vídeo certo.
- **Quem sai da sala some na hora.** Sair, fechar a janela ou encerrar o programa tira a pessoa da lista em menos de meio segundo (antes ela continuava aparecendo por até 30 segundos). Se a internet cair de repente, a pessoa tem 5 segundos para voltar sem que ninguém perceba; passado isso, sai da lista e volta a entrar sozinha quando a conexão voltar.
- **Nomes na sala.** Você escolhe um nome (fica lembrado), o painel mostra quem está na sala e aparecem avisos de "X entrou na sala" e "X saiu da sala".
- A barra de cima ganhou o botão do microfone e continua sem cortar nenhum botão em qualquer largura de janela (de 240 a 700 px e mais).
- Salas e programas da 1.3.x continuam funcionando com o servidor novo, só sem o tempo real e a voz. **Quem monta o próprio servidor:** ele agora é um Worker com Durable Object e não usa mais o D1; o passo a passo atualizado está em `relay/LEIA-ME.md`.
- Privacidade: o microfone só é ligado quando você clica no botão, e só o próprio programa pode usá-lo (o YouTube e outros sites dentro dele, não). Quem está na voz enxerga o endereço IP das outras pessoas na voz, como em qualquer chamada direta pela internet.

## v1.3.1 - 2026-11-12

- **Salas no ar.** O servidor de salas (Cloudflare, plano grátis) já está funcionando e o botão **Sala** (ícone de pessoas) aparece na barra de cima e na tela inicial. **Criar sala** mostra um código de 8 letras e números; quem tem o código usa **Entrar**. Quem põe, pausa, pula, muda a velocidade ou troca de vídeo, muda para todos, e cada pessoa toca o seu próprio vídeo (não é transmissão de tela). Pequenos atrasos são corrigidos sozinhos, mesmo com o relógio do computador adiantado ou atrasado. Esta versão chega sozinha a quem já tem a 1.3.0.
- Correção nas salas: uma pausa, um play ou uma mudança de velocidade feita logo depois de a sala mudar (menos de 2 segundos) era ignorada e não chegava aos outros. Agora só o que a própria sala causou no vídeo é ignorado.

## v1.3.0 - 2026-11-12

- **Atualização automática.** Ao abrir, o programa confere no GitHub se há uma versão nova. Se houver, baixa o arquivo, confere o SHA-256 que o próprio GitHub informa e mostra um aviso verde **"Nova versão X · Atualizar"** junto com a barra de cima. Um clique troca os arquivos, abre a versão nova e volta ao mesmo vídeo e minuto. Se você não clicar, a atualização é instalada sozinha na próxima vez que abrir o programa. Se a versão nova não abrir, tudo volta ao que era. Pasta sem permissão de escrita: o aviso vira **"Baixar"** e abre a página da versão. Para desligar, ponha `update=0` no `config.ini`. **Quem está na 1.2.0 ou antes precisa baixar esta versão uma vez; daí em diante é automático.**
- **Salas para assistir junto (em preparação).** O código das salas já está no programa: com um código de 8 letras, todo mundo vê o mesmo vídeo ao mesmo tempo (quem põe, pausa, pula, muda a velocidade ou troca de vídeo, muda para todos; cada pessoa toca o seu próprio vídeo). O botão **Sala** só aparece quando há um servidor de salas configurado, e a versão pública ainda não tem um. O passo a passo para montar o servidor (grátis, no Cloudflare) está em `relay/LEIA-ME.md`.
- O painel da sala se adapta a janelas bem pequenas (sem barra de rolagem feia).
- Opção `--minimized` na linha de comando: abre o programa minimizado.

## v1.2.0 - 2026-11-12

- **Pesquisa do YouTube dentro do programa.** A tela de pesquisa (**Ctrl+L** ou o botão da lupa) aceita texto: digite o que procura e os resultados do YouTube aparecem numa janela por baixo da barra do programa. Ao clicar num vídeo, ele toca no seu player (com a velocidade livre e os atalhos), e a pesquisa fica guardada para você voltar a ela. Link colado no campo continua tocando direto. O botão do campo muda sozinho entre "Reproduzir" e "Buscar".
- **Spotify como módulo extra.** Um botão na tela de pesquisa (e uma aba na barra do modo navegação) abre o player web do Spotify dentro do programa. Entre na sua conta uma vez e as suas playlists e músicas curtidas aparecem; o Spotify continua tocando quando você volta ao player.
- Nova barra do modo navegação (voltar ao player, abas YouTube/Spotify, campo de pesquisa, página inicial, fixar, minimizar, fechar) que se adapta a qualquer largura de janela. A janela do site acompanha o redimensionamento e as bordas continuam livres para redimensionar.
- A tela inicial ganhou os atalhos "Colar link", "Explorar YouTube" e "Spotify".

## v1.1.0 - 2026-11-12

- **A barra do programa não cobre mais os botões do YouTube.** Antes ela ocupava a largura toda e tapava o mudo, as **legendas (CC)** e a engrenagem, que ficam no canto superior direito. Agora é uma pílula no canto esquerdo (que se encolhe nas janelas pequenas) e deixa esse canto livre. Ela inteira arrasta a janela, menos os botões.
- **Velocidade livre pelo teclado**, como no *Video Speed Controller*: **D** acelera e **S** desacelera (0,1× por toque; com **Shift**, 1×), **R** volta a 1× (de novo, volta à velocidade anterior). Vai de **0,07× até 16×** (o player do YouTube só chega a 2×). A velocidade fica lembrada para o próximo vídeo e para a próxima vez que abrir o programa. Um selo na barra e um aviso no meio do vídeo mostram o valor.
- **Z** e **X** voltam e avançam 10 segundos.
- O foco volta para o vídeo depois de clicar num botão da barra, para as teclas (e as do próprio YouTube, como **C** para legendas) continuarem valendo.

## v1.0.0 - 2026-11-12

- Primeira versão: mini player de YouTube por cima de tudo, com link colado por Ctrl+V, janela sem borda que se move e redimensiona por qualquer lado, interface responsiva, transparência, "sempre por cima", tela cheia e posição lembrada.
