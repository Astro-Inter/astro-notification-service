CREATE TABLE unidade (id_unidade bigint PRIMARY KEY, workspace_id bigint, ativo boolean);
CREATE TABLE cargo (id_cargo bigint PRIMARY KEY, workspace_id bigint, ativo boolean);
CREATE TABLE usuario (id_usuario bigint PRIMARY KEY, cargo_id bigint, unidade_id bigint, tipo text, status text);
CREATE TABLE nr_catalogo (codigo_nr integer PRIMARY KEY, revogada boolean);
CREATE TABLE conformidade (id_conformidade bigint PRIMARY KEY, usuario_id bigint, nr_id integer, aplicavel boolean, data_validade date);
CREATE TABLE evento (id_evento bigint PRIMARY KEY, gestor_id bigint, titulo text, status text);
CREATE TABLE turma (id_turma bigint PRIMARY KEY, evento_id bigint, data_termino timestamp);
CREATE TABLE turma_colaborador (id_turma_colaborador bigint PRIMARY KEY, turma_id bigint, usuario_id bigint);
CREATE TABLE conclusao_evento (id_conclusao_evento bigint PRIMARY KEY, turma_colaborador_id bigint UNIQUE, status text, data_conclusao timestamp, data_validacao timestamp);
