use super::*;
use serde_json::json;

#[test]
fn adds_the_same_tree_as_parse() {
    let mut m = json!({"id": "m1", "body": "a **b**"});
    add_to_message(&mut m);
    assert_eq!(m["markdown"], blocks_value("a **b**"));
    assert_eq!(m["markdown"][0]["type"], "paragraph");
    assert_eq!(m["body"], "a **b**", "body is kept as is");
}

#[test]
fn leaves_values_without_a_string_body_alone() {
    let mut none = json!({"id": "m1"});
    add_to_message(&mut none);
    assert!(none.get("markdown").is_none());

    let mut num = json!({"body": 3});
    add_to_message(&mut num);
    assert!(num.get("markdown").is_none());

    let mut list = json!([1, "x"]);
    add_to_messages(&mut list);
    assert_eq!(list, json!([1, "x"]));
}

#[test]
fn adds_to_every_message_in_a_list() {
    let mut list = json!([{"body": "x"}, {"body": ""}]);
    add_to_messages(&mut list);
    assert_eq!(list[0]["markdown"], blocks_value("x"));
    assert_eq!(list[1]["markdown"], blocks_value(""));
}
