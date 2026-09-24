export const STATUS = ['pending', 'accepted', 'preparing', 'ready', 'delivering', 'delivered', 'cancelled'];

/** Allowed forward transitions. Pickup / dine-in skip "delivering". */
export function allowedNext(order) {
  switch (order.status) {
    case 'pending': return ['accepted'];
    case 'accepted': return ['preparing'];
    case 'preparing': return ['ready'];
    case 'ready': return order.fulfillment === 'delivery' ? ['delivering'] : ['delivered'];
    case 'delivering': return ['delivered'];
    default: return [];
  }
}
