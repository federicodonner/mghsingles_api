const messages = {
  USER_NOT_FOUND:
    "El usuario especificado no existe, revise los datos y vuelva a intentarlo.",
  INCORRECT_PASSWORD: "La contraseña ingresada es incorrecta.",
  UNAUTHORIZED: "Ocurrió un error, por favor vuelve a ingresar.",
  PARAMETERS_ERROR:
    "Algunos de los parámetros no son correctos, verifícalos y vuelve a intentar.",
  USERNAME_INCORRECT:
    "El nombre de usuario seleccionado no es correcto, por favor seleccione otro.",
  USERNAME_REPEAT:
    "El nombre de usuario seleccionado ya está en uso, por favor seleccione otro.",
  EMAIL_ERROR: "El email no tiene formato correcto.",
  USERNAME_CORRECT: "El nombre de usuario seleccionado es correcto.",
  COLLECTION_PROBLEM:
    "Hubo un problema cargando tu colección, por favor inténtalo nuevamente más tarde o ponte en contacto con el administrador.",
  CARD_NOT_FOUND: "La carta especificada no existe, por favor verifícala.",
  SET_NOT_FOUND: "El set especificado no existe.",
  COLLECTION_UPDATED: "Su colección ha sido actualizada con éxito.",
  TOO_MANY_CARDS:
    "Tu búsqueda devolvió demasiadas cartas, por favor intenta nuevamente con términos más específicos.",
  SEARCH_NOT_FOUND: "Carta no encontrada, por favor verifique la búsqueda.",
  SEARCH_NEEDS_CRITERIA:
    "Escribe un nombre o elegí un filtro para buscar en la tienda.",
  SALE_REPEAT_CARDS: "Hay cartas repetidas en la venta, por favor verifíquela.",
  SALE_NOT_ENOUGH_STOCK:
    "No hay stock suficiente de una de las cartas para la venta.",
  SALE_PROCESSED: "Venta procesada correctamente.",
  USER_UPDATED: "Tus datos han sido actualizados",
  REQUEST_TIMEOUT:
    "La solicitud falló por demora. Intenta nuevamente más tarde.",
  UPDATE_FINISHED_1: "Actualización terminada, ",
  UPDATE_FINISHED_2: " cartas añadidas a la base de datos.",
  NOT_FOUND: "El recurso solicitado no existe.",
  SERVER_ERROR:
    "Ocurrió un error inesperado, por favor inténtalo nuevamente más tarde.",
  STORAGE_NOT_FOUND: "El contenedor especificado no existe.",
  STORAGE_NOT_EMPTY:
    "El contenedor todavía tiene cartas, vacíalo antes de eliminarlo.",
  STORAGE_DELETED: "El contenedor fue eliminado.",
  STORAGE_SHOP_OWNED:
    "Este contenedor es de la tienda, no puede entregarse a un cliente.",
  STORAGE_NOT_YOURS: "Ese contenedor no es tuyo.",
  STORAGE_BAD_STATE: "El contenedor no puede pasar a ese estado desde el actual.",
  STORAGE_NOT_EDITABLE:
    "Sólo podés reordenar un contenedor que ya te fue entregado.",
  STORAGE_WITH_CUSTOMER:
    "Ese contenedor está en manos de su dueño, la tienda no puede modificarlo.",
  STORAGE_RETIRED:
    "El contenedor fue retirado, sus cartas ya no están a la venta.",
  STORAGE_RELEASED: "El contenedor fue entregado a su dueño.",
  STORAGE_RETURNING: "Avisaste que traés el contenedor a la tienda.",
  STORAGE_FOR_SALE: "El contenedor está en la tienda y sus cartas a la venta.",
  CARD_NOT_YOURS: "Esa carta no es tuya.",
  CARD_DIGITAL_ONLY:
    "Esa versión sólo existe en formato digital (Arena o MTGO), no se puede vender en la tienda.",
  PLACEMENT_COMMITTED:
    "Esa copia está apartada para un pedido, no se puede mover hasta entregarla.",
  COPY_ALREADY_PLACED: "Esa copia ya está guardada en un contenedor.",
  ALL_COPIES_PLACED: "Todas las copias de esta carta ya están guardadas.",
  PLACEMENT_NOT_FOUND: "La ubicación especificada no existe.",
  PLACEMENT_REMOVED: "La carta fue retirada del contenedor.",
  ORDER_NOT_FOUND: "El pedido especificado no existe.",
  ORDER_NOT_PENDING: "El pedido ya fue cerrado.",
  ORDER_REPEAT_CARDS: "Hay cartas repetidas en el pedido.",
  ORDER_NOT_ENOUGH_STOCK:
    "No hay stock suficiente de una de las cartas para reservarla.",
  ORDER_CANCELLED: "El pedido fue cancelado y las cartas quedaron disponibles.",
  ORDER_COMPLETED: "El pedido fue entregado y cobrado.",
  ORDER_HANDED_OVER: "Las cartas fueron entregadas a su dueño.",
  CARD_NOT_AVAILABLE: "Esta carta no está a la venta.",
  WISHLIST_REPEAT: "Esa carta ya está en tu lista de deseados.",
  WISHLIST_NOT_FOUND: "Ese deseado no existe.",
  WISHLIST_REMOVED: "La carta fue quitada de tu lista de deseados.",
  FINISH_NOT_AVAILABLE:
    "Esta versión de la carta no existe en esa terminación.",
  MATCH_NOT_FOUND: "Esa coincidencia ya no existe.",
  MATCH_SET_ASIDE: "La carta fue apartada para el cliente.",
  MATCH_DISMISSED: "La coincidencia fue descartada.",
  NOTIFICATION_NOT_FOUND: "Ese aviso no existe.",
  NOTIFICATION_REMOVED: "El aviso fue eliminado.",
  MULTIPLIERS_SAVED: "Los multiplicadores fueron guardados.",
  MULTIPLIER_RANGE:
    "Los multiplicadores deben estar entre 0 y 1 — un valor mayor pondría una carta jugada por encima de una NM.",
  PRICE_SAVED: "El precio fue guardado.",
  ROLE_SELF: "No puedes cambiar tu propio rol.",
  ROLE_LAST_OWNER:
    "Debe quedar al menos un dueño; asigna el rol a otra persona primero.",
  ROLE_SAVED: "El rol fue actualizado.",
  PAYMENT_REGISTERED: "El pago fue registrado correctamente.",
};

export default messages;
