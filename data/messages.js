const messages = {
  USER_NOT_FOUND:
    "El usuario especificado no existe, revise los datos y vuelva a intentarlo.",
  INCORRECT_PASSWORD: "La contraseña ingresada es incorrecta.",
  // One message for "no such user" AND "wrong password", so login cannot be
  // used to discover which accounts exist.
  INCORRECT_CREDENTIALS:
    "Usuario o contraseña incorrectos. Revisá los datos y volvé a intentar.",
  LOGGED_OUT: "Sesión cerrada.",
  TOO_MANY_REQUESTS:
    "Demasiados intentos. Esperá unos minutos y volvé a intentar.",
  PASSWORD_TOO_SHORT:
    "La contraseña debe tener al menos 8 caracteres.",
  UNAUTHORIZED: "Ocurrió un error, por favor vuelve a ingresar.",
  PARAMETERS_ERROR:
    "Algunos de los parámetros no son correctos, verifícalos y vuelve a intentar.",
  USERNAME_INCORRECT:
    "El nombre de usuario seleccionado no es correcto, por favor seleccione otro.",
  USERNAME_REPEAT:
    "El nombre de usuario seleccionado ya está en uso, por favor seleccione otro.",
  EMAIL_REPEAT:
    "Ese email ya está registrado. Si la cuenta es tuya, ingresá con él.",
  EMAIL_ERROR: "El email no tiene formato correcto.",
  USERNAME_CORRECT: "El nombre de usuario seleccionado es correcto.",
  COLLECTION_PROBLEM:
    "Hubo un problema cargando tu colección, por favor inténtalo nuevamente más tarde o ponte en contacto con el administrador.",
  STOCK_NO_COLLECTION:
    "La cuenta que recibe estas cartas no tiene una colección activa donde guardarlas. Que el dueño la cree desde la administración.",
  OWNER_NO_COLLECTION:
    "El cliente elegido no tiene una colección activa donde recibir las cartas.",
  STORAGE_HAS_BAGGED:
    "El contenedor tiene cartas apartadas para un pedido. Resolvé esos pedidos antes de cambiar el dueño.",
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
  CREDIT_ADJUSTED: "El crédito fue ajustado.",
  CREDIT_NOT_CUSTOMER: "Solo los clientes tienen crédito de tienda.",
  CREDIT_NO_RATE:
    "No hay un tipo de cambio configurado para convertir el crédito.",
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
  STORAGE_NOT_SORTED: "Ese contenedor no es una caja ordenada.",
  STORAGE_CUSTOMER_OWNED:
    "Este contenedor es de un cliente; devolvéselo en vez de eliminarlo.",
  STORAGE_EDIT_SHOP_ONLY:
    "La tienda sólo puede agregar o quitar cartas de sus propios contenedores.",
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
  MOXFIELD_BAD_URL:
    "Eso no parece un link de un mazo de Moxfield.",
  MOXFIELD_NOT_FOUND:
    "No se encontró el mazo. Verificá el link y que el mazo sea público.",
  MOXFIELD_ERROR:
    "No se pudo leer el mazo de Moxfield, intentá de nuevo más tarde.",
  MANABOX_BAD_FILE:
    "Ese archivo no parece una exportación de ManaBox (falta la cabecera).",
  MANABOX_TOO_LARGE:
    "El archivo tiene demasiadas filas. Dividilo en partes más chicas.",
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
  LINE_REMOVED: "La carta fue quitada del pedido y volvió a estar disponible.",
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
  CARD_RESERVED_FOR_YOU:
    "Pedida. Te avisamos cuando esté apartada para que la retires.",
  CART_ADDED: "Agregada al carrito.",
  CART_ITEM_NOT_FOUND: "Esa carta no está en tu carrito.",
  CART_ITEM_REMOVED: "La carta fue quitada del carrito.",
  CART_EMPTY: "Tu carrito está vacío.",
  CART_NOT_ENOUGH_STOCK:
    "No hay stock suficiente de esa carta para agregarla al carrito.",
  CART_LINE_LIMIT:
    "Llegaste al máximo de copias por carta. Escribinos para una compra mayor.",
  CART_NOT_FOR_SALE: "Esta carta todavía no tiene precio y no está a la venta.",
  CART_OWN_CARD:
    "Esta carta es tuya. Usá \"pedir que me lo devuelvan\" para retirarla.",
  WITHDRAW_ONLY_IN_SHOP:
    "Sólo podés pedir cartas de un contenedor que está en la tienda.",
  WITHDRAW_REQUESTED:
    "Pedido registrado. Te avisamos cuando esté pronta para retirar.",
  CARD_WRONG_CONTAINER:
    "Una carta sólo puede guardarse en un contenedor de su dueño.",
  REFILE_CLEARED: "Listo, cartas devueltas a su lugar.",
  PIN_REMOVED: "El precio vuelve a seguir al mercado.",
  PAYMENT_DONE: "Pago registrado.",
  CREDIT_NOT_YOURS: "Este pedido no tiene un cliente al que aplicarle crédito.",
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
