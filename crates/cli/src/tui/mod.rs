//! `disnans tui`: メインチャットを読んで送るターミナル画面。

mod app;
mod commands;
mod device;
mod graphics;
mod input;
mod markdown;
mod net;
mod picture;
mod sanitize;
mod search;
mod settings;
mod suggest;
mod terminal;
mod textbuf;
mod transcript;
mod ui;
mod view;

pub use net::run;
