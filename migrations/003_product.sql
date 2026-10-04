-- Product cancellation intent only. PokerTools owns all financial disposition.
CREATE TABLE product_room_cancellations (
  room_id TEXT PRIMARY KEY REFERENCES product_rooms(id),
  requested_at INTEGER NOT NULL
);
