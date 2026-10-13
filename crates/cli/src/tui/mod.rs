//! `disnans tui`: メインチャットを読んで送る端末画面。

mod app;
mod input;
mod net;
mod sanitize;
mod terminal;
mod textbuf;
mod transcript;
mod view;

pub use net::run;
