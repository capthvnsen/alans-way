'use strict';

function connectorReplaced(startup, current) {
  return Object.keys(startup).some((file) => Number(current[file]) > Number(startup[file]));
}

module.exports = { connectorReplaced };
