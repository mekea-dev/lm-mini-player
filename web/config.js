/*
 * LM Mini Player - configuracao.
 *
 * relay: endereco do servidor de salas (veja relay\LEIA-ME.md para criar o seu na Cloudflare).
 *        Vazio = as salas ficam desligadas. Quem fizer um fork precisa montar o proprio servidor:
 *        este endereco e o do servidor do projeto original e e so para as salas (guarda codigo da sala,
 *        video, posicao e se esta tocando; nada pessoal).
 */
window.LM_CONFIG = {
  relay: 'https://lm-salas.leonardomaquea96.workers.dev'
};
